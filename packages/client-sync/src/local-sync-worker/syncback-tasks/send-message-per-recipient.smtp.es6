const {Errors: {APIError}, MessageUtils, ModelUtils} = require('isomorphic-core')
const {SyncbackSMTPTask} = require('./syncback-task')


/**
 * This enables customized link and open tracking on a per-recipient basis
 * by delivering several messages to each recipient.
 *
 * Errors in this task always mean all message failed to send to all
 * receipients.
 *
 * If it failed to some recipients, we return a `failedRecipients` array
 * to notify the user.
 *
 * We later get EnsureMessageInSentFolder queued with the
 * `customSentMessage` flag set to ensure the newly delivered message shows
 * up in the sent folder and only a single message shows up in the sent
 * folder.
 */
class SendMessagePerRecipientSMTP extends SyncbackSMTPTask {
  description() {
    return `SendMessagePerRecipient`;
  }

  async * _run(db, smtp) {
    const syncbackRequest = this.syncbackRequestObject()
    const {
      messagePayload,
      usesOpenTracking,
      usesLinkTracking,
    } = syncbackRequest.props;
    const baseMessage = yield MessageUtils.buildForSend(db, messagePayload)

    yield syncbackRequest.update({
      status: 'INPROGRESS-NOTRETRYABLE',
    })

    let sendResult;
    try {
      sendResult = yield this._sendPerRecipient({
        db, smtp, baseMessage, logger: this._logger, usesOpenTracking, usesLinkTracking})
    } catch (err) {
      throw new APIError('SendMessagePerRecipient: Sending failed for all recipients', 500);
    }
    /**
     * Once messages have actually been delivered, we need to be very
     * careful not to throw an error from this task. An Error in the send
     * task implies failed delivery and the prompting of users to try
     * again.
     */
    try {
      // We strip the tracking links because this is the message that we want to
      // show the user as sent, so it shouldn't contain the tracking links
      baseMessage.body = MessageUtils.stripTrackingLinksFromBody(baseMessage.body)
      baseMessage.setIsSent(true)

      // We don't save the message until after successfully sending it.
      // In the next sync loop, the message's labels and other data will
      // be updated, and we can guarantee this because we control message
      // id generation. The thread will be created or updated when we
      // detect this message in the sync loop
      yield baseMessage.save()

      return {
        message: baseMessage.toJSON(),
        failedRecipients: sendResult.failedRecipients,
      }
    } catch (err) {
      this._logger.error('SendMessagePerRecipient: Failed to save the baseMessage to local sync database after it was successfully delivered', err);
      return {message: {}, failedRecipients: []}
    }
  }

  async _sendPerRecipient({db, smtp, baseMessage, usesOpenTracking, usesLinkTracking} = {}) {
    const {Message} = db
    const recipients = baseMessage.getRecipients()
    const failedRecipients = []

    for (const recipient of recipients) {
      const customBody = MessageUtils.buildTrackingBodyForRecipient({
        recipient,
        baseMessage,
        usesOpenTracking,
        usesLinkTracking,
      })

      const individualizedMessage = ModelUtils.copyModel(Message, baseMessage, {
        body: customBody,
      })
      // TODO we set these temporary properties which aren't stored in the
      // database model because SendmailClient requires them to send the message
      // with the correct headers.
      // This should be cleaned up
      individualizedMessage.references = baseMessage.references;
      individualizedMessage.inReplyTo = baseMessage.inReplyTo;

      try {
        await smtp.sendCustom(individualizedMessage, {to: [recipient]})
      } catch (error) {
        this._logger.error(error, {recipient: recipient.email}, 'SendMessagePerRecipient: Failed to send to recipient');
        failedRecipients.push(recipient.email)
      }
    }
    if (failedRecipients.length === recipients.length) {
      throw new APIError('SendMessagePerRecipient: Sending failed for all recipients', 500);
    }
    return {failedRecipients}
  }
}

module.exports = SendMessagePerRecipientSMTP;
