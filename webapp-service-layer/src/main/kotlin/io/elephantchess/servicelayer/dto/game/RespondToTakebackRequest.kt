package io.elephantchess.servicelayer.dto.game

data class RespondToTakebackRequest(
    val gameId: String,
    val accept: Boolean,
)
