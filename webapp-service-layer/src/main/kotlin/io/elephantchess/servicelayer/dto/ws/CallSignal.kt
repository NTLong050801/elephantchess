package io.elephantchess.servicelayer.dto.ws

/**
 * WebRTC voice-call signaling message, relayed verbatim between the two players of a game.
 *
 * The server never interprets [payload] (SDP offer/answer or ICE candidate JSON produced by
 * RTCPeerConnection) — it only validates the sender is a player and forwards it to the
 * other session(s) of the same game.
 */
data class CallSignal(
    val type: CallSignalType,
    val payload: String? = null,
    val fromUserId: String? = null,
)

enum class CallSignalType {
    CALL_OFFER,
    CALL_ANSWER,
    ICE_CANDIDATE,
    CALL_REJECT,
    CALL_END,
}
