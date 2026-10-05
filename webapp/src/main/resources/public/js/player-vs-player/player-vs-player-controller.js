const WARNING_TIME_OUT = 4_000;

/**
 * Manages the state of the game and timers, and push state changes to the UI (via callbacks).
 * The UI only interacts with this class to fetch game state related data.
 */
class GameController {

    /**
     * @type {string}
     */
    #gameId;

    /**
     * @type {GameDto|null}
     */
    #gameDto = null;

    /**
     * @type {string}
     */
    #gameState;

    #updateClockTimerId = null;

    /**
     * @type {GameClient}
     */
    #client;

    /**
     * @type {WebSocket|null}
     */
    #webSocket = null;

    /**
     * Wall-clock timestamps (epoch millis) for each move played in the game.
     * Parallel to the moves list. Null until the moves history has been fetched.
     * @type {number[]|null}
     */
    #moveTimestamps = null;

    /**
     * Wall-clock timestamp (epoch millis) at which the game started (invitee joined).
     * Null until the moves history has been fetched (or if not applicable).
     * @type {number|null}
     */
    #joinTime = null;

    #inviteeJoinedCallback = () => console.log('invitee joined');
    #stateUpdateCallback = () => console.log('state updated');
    #opponentMoveReceivedCallback = () => console.log('opponent move received');
    #canceledReceivedCallback = () => console.log('game canceled');
    #winCallback = () => console.log('you win');
    #lossCallback = () => console.log('you loose');
    #resignReceivedCallback = () => console.log('resign received');
    #drawReceivedCallback = () => console.log('received draw');
    #drawAcceptedCallback = () => console.log('draw accepted');
    #drawDeclinedCallback = () => console.log('draw declined');
    #takebackReceivedCallback = () => console.log('received takeback');
    #takebackAcceptedCallback = () => console.log('takeback accepted');
    #takebackDeclinedCallback = () => console.log('takeback declined');
    #takebackClearedCallback = () => console.log('takeback cleared');
    #updateClocksCallback = () => console.log('update clocks');
    #fetchMovesCallback = (moves) => console.log('fetch moves ' + moves);
    #receivedChatMessages = (chatMessages, acks) => console.log('received chat messages ' + chatMessages);
    #opponentTypingCallback = (typingUsers) => console.log('opponents are typing: ' + JSON.stringify(typingUsers));

    /**
     * @param gameId {string}
     * @param initCallback {function()}
     * @param inviteeJoinedCallback {function()}
     * @param stateUpdateCallback {function()} Called when user opens the page (for initialization) and when opponent joins
     * @param opponentMoveReceivedCallback {function()}
     * @param canceledReceivedCallback {function()}
     * @param winCallback {function()}
     * @param lossCallback {function()}
     * @param resignReceivedCallback {function()}
     * @param drawReceivedCallback {function()}
     * @param drawAcceptedCallback {function()}
     * @param drawDeclinedCallback {function()}
     * @param takebackReceivedCallback {function()}
     * @param takebackAcceptedCallback {function()}
     * @param takebackDeclinedCallback {function()}
     * @param takebackClearedCallback {function()}
     * @param updateClocksCallback {function()}
     * @param fetchMovesCallback {function(HalfMove[])}
     * @param receivedChatMessages {function(ChatMessageDto[], number[])}
     * @param opponentTypingCallback {function(Array<Object.<string,string, *>>)} Map of userId→username for users currently typing
     */
    constructor(
        gameId,
        initCallback,
        inviteeJoinedCallback,
        stateUpdateCallback,
        opponentMoveReceivedCallback,
        canceledReceivedCallback,
        winCallback,
        lossCallback,
        resignReceivedCallback,
        drawReceivedCallback,
        drawAcceptedCallback,
        drawDeclinedCallback,
        takebackReceivedCallback,
        takebackAcceptedCallback,
        takebackDeclinedCallback,
        takebackClearedCallback,
        updateClocksCallback,
        fetchMovesCallback,
        receivedChatMessages,
        opponentTypingCallback = (typingUsers) => {
        }
    ) {
        this.#gameId = gameId;
        this.#inviteeJoinedCallback = inviteeJoinedCallback;
        this.#stateUpdateCallback = stateUpdateCallback;
        this.#opponentMoveReceivedCallback = opponentMoveReceivedCallback;
        this.#canceledReceivedCallback = canceledReceivedCallback;
        this.#winCallback = winCallback;
        this.#lossCallback = lossCallback;
        this.#resignReceivedCallback = resignReceivedCallback;
        this.#drawReceivedCallback = drawReceivedCallback;
        this.#drawAcceptedCallback = drawAcceptedCallback;
        this.#drawDeclinedCallback = drawDeclinedCallback;
        this.#takebackReceivedCallback = takebackReceivedCallback || (() => {});
        this.#takebackAcceptedCallback = takebackAcceptedCallback || (() => {});
        this.#takebackDeclinedCallback = takebackDeclinedCallback || (() => {});
        this.#takebackClearedCallback = takebackClearedCallback || (() => {});
        this.#updateClocksCallback = updateClocksCallback;
        this.#fetchMovesCallback = fetchMovesCallback;
        this.#receivedChatMessages = receivedChatMessages;
        this.#opponentTypingCallback = opponentTypingCallback;
        this.#client = new GameClient(gameId);

        this.#client.getData(gameDto => {
            this.#updateGameDto(gameDto);
            connectToWs();
            if (!this.isGameFinished()) {
                if (this.isGameInProgress()) {
                    if (this.#gameDto.hasReceiveDrawProposition()) {
                        this.#drawReceivedCallback();
                    }
                    if (this.#gameDto.hasReceivedTakebackProposition()) {
                        this.#takebackReceivedCallback();
                    }
                }
                this.#startUpdateClocks();
            }

            this.#client.getMovesHistory((moves, moveTimestamps, joinTime) => {
                this.#moveTimestamps = moveTimestamps;
                this.#joinTime = joinTime;
                this.#fetchMovesCallback(moves);
            });
            this.#client.getChatHistory(messages => {
                this.#receivedChatMessages(messages, []);
            });
            initCallback();
        });

        const connectToWs = () => {
            const user = new User();

            if (!user.isIdentified) {
                console.log('userId not found yet, re-attempting in 1 second');
                setTimeout(() => {
                    connectToWs();
                }, 1_000);
                return;
            }

            const handle = openReconnectingWebSocket({
                endpoint: 'pvp/game',
                logLabel: 'pvp/game',
                networkBlockedMessage:
                    'Your network seems to be blocking real-time connections. ' +
                    'The game may not update in real time. ' +
                    'Try a different network, or disable your VPN / antivirus / browser extensions.',
                buildParams: () => new Map([
                    ['gameId', gameId],
                    ['token', getToken()],
                ]),
                onOpen: (ws) => {
                    this.#webSocket = ws;
                },
                onMessage: (e) => {
                    const json = JSON.parse(e.data);
                    const dto = this.#gameDto;
                    const statusHasChanged = json.status !== dto.status;
                    const isWaitingForDrawResponse = dto.isWaitingForDrawPropositionResponse();

                    let newMoveDto = null;
                    if (json.newMove != null) {
                        newMoveDto = new NewMoveDto(json.newMove);
                    }

                    let ratingUpdate = null;
                    if (json.ratingUpdate != null) {
                        ratingUpdate = new RatingUpdateDto(json.ratingUpdate);
                    }

                    let timeRemainingDto = null;
                    if (json.timeRemaining != null) {
                        timeRemainingDto = new TimeRemainingDto(json.timeRemaining);
                    }

                    const chatMessages = [];
                    if (json.chatMessages != null) {
                        for (const message of json.chatMessages) {
                            chatMessages.push(new ChatMessageDto(message));
                        }
                    }

                    this.#gameDto.status = json.status;

                    if (statusHasChanged) {
                        switch (this.#gameDto.status) {
                            case GameEventType.CANCELED:
                                this.#gameDto.updateForCanceled();
                                if (this.#gameDto.userStatus !== UserStatus.INVITER) {
                                    this.#canceledReceivedCallback();
                                }
                                break;
                            case GameEventType.FLAGGED:
                                this.#handleFlagged(ratingUpdate);
                                break;
                            case GameEventType.RESIGNED:
                                this.#handleResignationReceived(ratingUpdate);
                                break;
                            case GameEventType.DRAW_PROPOSED:
                                const isPlayer = dto.userStatus !== UserStatus.SPECTATOR;
                                if (!isWaitingForDrawResponse && isPlayer) {
                                    this.#gameDto.updateForDrawPropositionReceived(json.drawPropositionUser);
                                    this.#drawReceivedCallback();
                                }
                                break;
                            case GameEventType.DRAW_ACCEPTED:
                                if (isWaitingForDrawResponse) {
                                    dto.updateForDrawResponse(true);
                                    this.#drawAcceptedCallback();
                                }
                                break;
                            case GameEventType.DRAW_DECLINED:
                                if (isWaitingForDrawResponse) {
                                    dto.updateForDrawResponse(false);
                                    this.#drawDeclinedCallback();
                                }
                                break;
                        }
                    }
                    // takeback proposition (independent of status)
                    const prevTakebackUser = dto.takebackPropositionUser;
                    const newTakebackUser = json.takebackPropositionUser !== undefined ? json.takebackPropositionUser : prevTakebackUser;
                    if (newTakebackUser !== prevTakebackUser) {
                        if (newTakebackUser != null && dto.userStatus !== UserStatus.SPECTATOR) {
                            if (newTakebackUser !== new User().userId) {
                                dto.updateForTakebackProposed(newTakebackUser);
                                this.#takebackReceivedCallback();
                            } else {
                                dto.updateForTakebackProposed(newTakebackUser);
                            }
                        } else if (newTakebackUser == null && prevTakebackUser != null) {
                            // cleared (declined or auto-cleared)
                            const wasWaiting = dto.isWaitingForTakebackResponse();
                            dto.clearTakebackProposition();
                            if (!wasWaiting && dto.userStatus !== UserStatus.SPECTATOR) {
                                // we were the receiver and it was cleared without explicit accept => declined/auto
                                // only notify if we had received it
                            } else if (wasWaiting) {
                                this.#takebackDeclinedCallback();
                            } else {
                                this.#takebackClearedCallback();
                            }
                        }
                    }
                    // takeback accepted: index decreased
                    if (json.takebackUpdate != null) {
                        const tu = json.takebackUpdate;
                        dto.updateForTakebackAccepted(tu.updatedFen, tu.updatedIndex);
                        // refresh move history from server
                        this.#client.getMovesHistory((moves, moveTimestamps, joinTime) => {
                            this.#moveTimestamps = moveTimestamps;
                            this.#joinTime = joinTime;
                            this.#fetchMovesCallback(moves);
                        });
                        this.#updateGameState(true);
                        this.#updateClocksCallback();
                        this.#takebackAcceptedCallback();
                    }
                    if (json.hasJoined != null) {
                        const hasJoinedStatus = new HasJoinedStatusDto(json.hasJoined);
                        this.#gameDto.updateOpponentHasJoined(hasJoinedStatus);
                        this.#updateGameState();
                        this.#inviteeJoinedCallback();
                    }
                    if (newMoveDto != null) {
                        if (this.#gameDto.moveIndex + 1 === newMoveDto.updatedIndex) {
                            this.#handleOpponentMove(newMoveDto, ratingUpdate);
                        } else if (this.#gameDto.moveIndex !== newMoveDto.updatedIndex) {
                            window.location.reload();
                        }

                        if (this.#gameDto.moveIndex === 6) {
                            gtagReportPvpMove3Conversion(window.location.href);
                        }
                    }
                    if (timeRemainingDto != null) {
                        this.#gameDto.updateTimeRemaining(timeRemainingDto);
                        this.#updateClocksCallback();
                    }
                    this.#handleReceivedChatMessages(chatMessages);
                    if (Array.isArray(json.typingUsers) && json.typingUsers.length > 0) {
                        this.#opponentTypingCallback(json.typingUsers);
                    }
                }
            });

            this.#webSocket = handle.getSocket();
        };
    }

    get gameId() {
        return this.#gameId;
    }

    get gameDto() {
        return this.#gameDto;
    }

    get gameState() {
        return this.#gameState;
    }

    get fen() {
        return this.#gameDto.fen;
    }

    getMoveTimestampAt(moveIndex) {
        if (this.#moveTimestamps == null) {
            return null;
        }
        if (moveIndex < 0 || moveIndex >= this.#moveTimestamps.length) {
            return null;
        }
        return this.#moveTimestamps[moveIndex];
    }

    getClockAtMoveIndex(moveIndex) {
        if (!this.#gameDto || !this.#gameDto.hasTimeControl()) {
            return null;
        }
        if (this.#moveTimestamps == null || this.#joinTime == null) {
            return null;
        }
        if (moveIndex < 0 || moveIndex >= this.#moveTimestamps.length) {
            return null;
        }

        const timeControl = this.#gameDto.timeControl;
        const baseMs = timeControl.base.toMillis();
        const incrementMs = timeControl.increment != null ? timeControl.increment.toMillis() : 0;

        if (this.#gameDto.timeControlMode === TimeControlMode.MOVE_TIME) {
            return new TimeControlClock(baseMs, baseMs);
        }

        let redMs = baseMs;
        let blackMs = baseMs;
        let prev = this.#joinTime;
        for (let i = 0; i <= moveIndex; i++) {
            const ts = this.#moveTimestamps[i];
            const elapsed = ts - prev;
            if (i % 2 === 0) {
                redMs -= elapsed;
                redMs += incrementMs;
            } else {
                blackMs -= elapsed;
                blackMs += incrementMs;
            }
            prev = ts;
        }
        if (redMs < 0) redMs = 0;
        if (blackMs < 0) blackMs = 0;
        return new TimeControlClock(redMs, blackMs);
    }

    buildPgnMetadata() {
        return this.#gameDto.buildPgnMetadata();
    }

    isGameInProgress() {
        return isStatusInProgress(this.#gameDto.status);
    }

    isGameFinished() {
        return isStatusFinished(this.#gameDto.status);
    }

    get userRatingUpdate() {
        if (this.#gameDto != null && this.#gameDto.hasRatingUpdate && this.#gameDto.ratingUpdate.isRated) {
            let ratingUpdate = this.#gameDto.ratingUpdate;
            switch (this.#gameDto.userStatus) {
                case UserStatus.INVITER:
                    return new UserRatingUpdate(ratingUpdate.inviterRatingFrom, ratingUpdate.inviterRatingTo);
                case UserStatus.INVITEE:
                    return new UserRatingUpdate(ratingUpdate.inviteeRatingFrom, ratingUpdate.inviteeRatingTo);
                default:
                    return null;
            }
        }
    }

    join(source, sourceId) {
        if (this.#gameDto.status === GameEventType.CREATED && isUserIdentified()) {
            this.#client.postJoin(source, sourceId, (color, rating) => {
                this.#gameDto.updateUserHasJoined(new User(), color, rating);
                this.#updateGameState();
            });
        } else {
            UI.pushErrorNotification('You can not join that game', WARNING_TIME_OUT);
        }
    }

    cancel(cb) {
        if (this.#gameDto.status === GameEventType.CREATED && isUserIdentified()) {
            this.#client.postCancel(() => {
                this.#gameDto.updateForCanceled();
                this.#updateGameState(true);
                cb();
            });
        } else {
            UI.pushErrorNotification('You can not cancel that game', WARNING_TIME_OUT);
        }
    }

    resign() {
        if (!this.isGameFinished()) {
            this.#gameDto.updateForResignationSent(null);
            this.#updateGameState();
            this.#client.postResign((maybeRatingUpdate) => {
                this.#gameDto.updateForResignationSent(maybeRatingUpdate);
                this.#stateUpdateCallback();
            });
        } else {
            UI.pushErrorNotification('Game has already ended', WARNING_TIME_OUT);
        }
    }

    proposeDraw() {
        if (!this.isGameFinished()) {
            this.#client.postProposeDraw(() => {
                this.#gameDto.updateForDrawPropositionSent();
            });
        } else {
            UI.pushErrorNotification('Game has already ended', WARNING_TIME_OUT);
        }
    }

    respondToDrawProposition(accept) {
        if (!this.isGameFinished()) {
            this.#client.postRespondToDraw(accept, () => {
                this.#gameDto.updateForDrawResponse(accept);
                this.#updateGameState();
            });
        } else {
            console.warn('game finished');
        }
    }

    proposeTakeback() {
        if (!this.isGameFinished() && this.#gameDto.canProposeTakeback()) {
            this.#client.postProposeTakeback(() => {
                this.#gameDto.updateForTakebackProposed(new User().userId);
                UI.pushNotification('Đã gửi yêu cầu xin đi lại, chờ đối thủ phản hồi...', 3000);
            });
        } else {
            UI.pushErrorNotification('Không thể xin đi lại lúc này', WARNING_TIME_OUT);
        }
    }

    respondToTakeback(accept) {
        if (!this.isGameFinished()) {
            this.#client.postRespondToTakeback(accept, () => {
                if (accept) {
                    // server will push takebackUpdate via WS; optimistic clear
                } else {
                    this.#gameDto.clearTakebackProposition();
                }
            });
        } else {
            console.warn('game finished');
        }
    }

    registerPlayerMove(move, okCb) {
        if (!this.isGameFinished()) {
            this.#client.postMove(move, (playMoveResponse) => {
                this.#gameDto.updateForUserMove(playMoveResponse);
                this.#updateClocksCallback();
                this.#updateGameState();
                if (this.#gameDto.userHasWon()) {
                    this.#winCallback();
                } else if (this.#gameDto.userHasLost()) {
                    this.#lossCallback();
                }
                okCb();
            });
        } else {
            console.warn('game finished');
        }
    }

    sendChat(message) {
        if (this.#webSocket != null) {
            this.#webSocket.send(JSON.stringify({"message": message}));
        }
    }

    sendTypingEvent() {
        if (this.#webSocket != null) {
            this.#webSocket.send(JSON.stringify({"isTyping": true}));
        }
    }

    isAllowedToSendChat(userId) {
        return (userId != null && this.#gameDto.status === GameEventType.CREATED) || this.#gameDto.isUserPlaying();
    }

    #handleOpponentMove(newMoveDto, ratingUpdate) {
        this.#gameDto.updateForOpponentMove(newMoveDto, ratingUpdate);
        this.#updateGameState();
        this.#updateClocksCallback();
        this.#opponentMoveReceivedCallback(newMoveDto.move);
        if (this.#gameDto.userStatus !== UserStatus.SPECTATOR && this.#gameDto.userHasLost()) {
            this.#lossCallback();
        }
        if (this.#gameDto.status === GameEventType.PERPETUAL_CHECKING) {
            this.#handlePerpetualCheckingReceived(ratingUpdate);
        }
    }

    #updateGameDto(gameDto) {
        this.#gameDto = gameDto;
        this.#updateGameState();
    }

    #updateGameState(forceCallback = false) {
        const before = this.#gameState;

        if (this.isGameFinished()) {
            this.#gameState = GameState.FINISHED;
            this.#stopUpdateClocks();
        } else if (!this.#gameDto.hasBeenJoined()) {
            this.#gameState = GameState.WAITING_FOR_INVITEE;
        } else if (this.#gameDto.isUserTurn()) {
            this.#gameState = GameState.USER_TURN;
        } else {
            this.#gameState = GameState.OPPONENT_TURN;
        }

        if (forceCallback || before !== this.#gameState) {
            this.#stateUpdateCallback();
        }
    }

    #startUpdateClocks() {
        if (this.#gameDto.hasTimeControl()) {
            this.#updateClockTimerId = setIntervalNoDelay(() => {
                this.#gameDto.decrementCounter();
                this.#updateClocksCallback();
            }, 1_000);
        }
    }

    #stopUpdateClocks() {
        clearInterval(this.#updateClockTimerId);
    }

    #handleFlagged(ratingUpdate) {
        this.#stopUpdateClocks();
        const clock = this.#gameDto.timeControlClock;
        const redMillis = clock.red.toMillis();
        const blackMillis = clock.black.toMillis();
        if (redMillis < blackMillis) {
            this.#updateForFlagged(Color.BLACK, ratingUpdate);
        } else if (redMillis > blackMillis) {
            this.#updateForFlagged(Color.RED, ratingUpdate);
        } else {
            console.warn('equal remaining counter, case not handled');
        }
    }

    #updateForFlagged(winnerColor, ratingUpdate) {
        this.#stopUpdateClocks();
        this.#gameDto.updateForFlagged(winnerColor, ratingUpdate);
        if (this.#gameDto.userStatus !== UserStatus.SPECTATOR) {
            if (this.#gameDto.colorUserPlaysWith === winnerColor) {
                this.#stateUpdateCallback();
                this.#winCallback();
            } else if (this.#gameDto.colorUserPlaysWith === reverseColor(winnerColor)) {
                this.#stateUpdateCallback();
                this.#lossCallback();
            }
        } else {
            window.location.reload();
        }
    }

    #handleResignationReceived(ratingUpdate) {
        this.#stopUpdateClocks();
        if (this.#gameDto.userStatus !== UserStatus.SPECTATOR) {
            const opponentColor = reverseColor(this.#gameDto.colorUserPlaysWith);
            this.#gameDto.updateForResignationReceived(opponentColor, ratingUpdate);
            this.#resignReceivedCallback();
        } else {
            window.location.reload();
        }
    }

    #handlePerpetualCheckingReceived(ratingUpdate) {
        this.#stopUpdateClocks();
        if (this.#gameDto.userStatus !== UserStatus.SPECTATOR) {
            const opponentColor = reverseColor(this.#gameDto.colorUserPlaysWith);
            this.#gameDto.updateForPerpetualCheckingReceived(opponentColor, ratingUpdate);
            this.#winCallback();
        } else {
            window.location.reload();
        }
    }

    #handleReceivedChatMessages(chatMessages) {
        const userId = new User().userId;
        if (userId != null && chatMessages.length > 0) {
            const acks = [];
            const receivedMessages = [];

            for (const message of chatMessages) {
                if (message.author.userId === userId) {
                    acks.push(message.index);
                } else {
                    receivedMessages.push(message);
                }
            }
            this.#receivedChatMessages(receivedMessages, acks);
        }
    }

}
