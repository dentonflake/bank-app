import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const serverUrl = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";
const sessionKey = "bank-session";
const tokenKey = "bank-player-token";

const socket = io(serverUrl, {
  autoConnect: false,
});

const emptyNameMessage = "Enter your name to continue.";
const formatPot = (value) => `$${value ?? 0}`;
const renderHearts = (count, className = "") => (
  <div
    className={`hearts ${className}`.trim()}
    role="img"
    aria-label={`Hearts ${count ?? 0} of 3`}
  >
    {[0, 1, 2].map((index) => (
      <span
        key={`heart-${index}`}
        className={`heart ${index < (count ?? 0) ? "filled" : "empty"}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M12 21.5l-1.4-1.3C5.2 15.3 2 12.4 2 8.9 2 6.1 4.2 4 7 4c1.7 0 3.3.8 4.3 2.1C12.7 4.8 14.3 4 16 4c2.8 0 5 2.1 5 4.9 0 3.5-3.2 6.4-8.6 11.3L12 21.5z" />
        </svg>
      </span>
    ))}
  </div>
);

const renderBolt = (hasMultiplier, className = "") => (
  <div
    className={`bolt ${className}`.trim()}
    role="img"
    aria-label={`2x multiplier ${hasMultiplier ? "owned" : "not owned"}`}
  >
    <span
      className={`bolt-icon ${hasMultiplier ? "filled" : "empty"}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M13.8 2L5 13.4h5.1L9.7 22 19 10.6h-5.2L13.8 2z" />
      </svg>
    </span>
  </div>
);

const readSession = () => {
  try {
    const raw = localStorage.getItem(sessionKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeSession = (session) => {
  localStorage.setItem(sessionKey, JSON.stringify(session));
};

const clearSession = () => {
  localStorage.removeItem(sessionKey);
};

const clearSessionAndToken = () => {
  localStorage.removeItem(sessionKey);
  localStorage.removeItem(tokenKey);
};

const getPlayerToken = () => {
  const existing = localStorage.getItem(tokenKey);
  if (existing) {
    return existing;
  }
  const token =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `player-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(tokenKey, token);
  return token;
};

function App() {
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState("");
  const [room, setRoom] = useState(null);
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [roundsInput, setRoundsInput] = useState(10);
  const [homeMode, setHomeMode] = useState(null);
  const [error, setError] = useState("");
  const [rollModal, setRollModal] = useState(null);
  const [kickPrompt, setKickPrompt] = useState(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [playerToken] = useState(() => getPlayerToken());
  const rollAudioRef = useRef(null);
  const bankAudioRef = useRef(null);
  const thudAudioRef = useRef(null);
  const lastEventRef = useRef("");
  const lastBustIdRef = useRef(0);
  const lastFinishedRef = useRef(false);

  useEffect(() => {
    const session = readSession();
    if (session?.name) {
      setName(session.name);
    }
    if (session?.roomId) {
      setRoomCode(session.roomId);
    }
  }, []);

  useEffect(() => {
    socket.connect();

    const handleConnect = () => {
      setConnected(true);
      setSocketId(socket.id);
      const session = readSession();
      if (session?.roomId && session?.name && session?.token) {
        socket.emit("room:reconnect", session);
      }
    };

    const handleDisconnect = () => {
      setConnected(false);
      setSocketId("");
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("room:state", (nextRoom) => {
      setRoom(nextRoom);
    });
    socket.on("room:error", (message) => {
      setError(message);
      if (message.toLowerCase().includes("room not found")) {
        clearSession();
      }
      setTimeout(() => setError(""), 2500);
    });
    socket.on("room:kicked", () => {
      clearSessionAndToken();
      setRoom(null);
      setHomeMode(null);
      setRoomCode("");
      setError("You were removed from the room.");
      setTimeout(() => setError(""), 2500);
    });

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("room:state");
      socket.off("room:error");
      socket.off("room:kicked");
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!rollAudioRef.current) {
      const audio = new Audio("/sounds/dice.mp3");
      audio.volume = 0.4;
      rollAudioRef.current = audio;
    }
    if (!bankAudioRef.current) {
      const audio = new Audio("/sounds/cash.mp3");
      audio.volume = 0.45;
      bankAudioRef.current = audio;
    }
    if (!thudAudioRef.current) {
      const audio = new Audio("/sounds/thud.mp3");
      audio.volume = 0.45;
      thudAudioRef.current = audio;
    }
  }, []);

  const me = useMemo(() => {
    if (!room) return null;
    return room.players.find((player) => player.id === socketId) || null;
  }, [room, socketId]);

  const winners = useMemo(() => {
    if (!room?.players || room.players.length === 0) {
      return [];
    }
    const topScore = Math.max(...room.players.map((player) => player.score));
    return room.players.filter((player) => player.score === topScore);
  }, [room]);

  useEffect(() => {
    if (room && me) {
      writeSession({
        roomId: room.id,
        name: me.name,
        token: playerToken,
      });
    }
  }, [room, me, playerToken]);

  useEffect(() => {
    if (!room) {
      return;
    }
    if (room.lastEvent && room.lastEvent !== lastEventRef.current) {
      lastEventRef.current = room.lastEvent;
    }
  }, [room]);

  useEffect(() => {
    if (!room) {
      return;
    }
    const finished = Boolean(room.finished);
    if (finished && !lastFinishedRef.current) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    lastFinishedRef.current = finished;
  }, [room]);


  useEffect(() => {
    if (!room || !socketId) {
      return;
    }
    const bustId = room.lastBustId ?? 0;
    if (bustId === 0 || bustId === lastBustIdRef.current) {
      return;
    }
    lastBustIdRef.current = bustId;
    if (room.lastBustPlayerIds?.includes(socketId)) {
      thudAudioRef.current?.play?.().catch(() => {});
    }
  }, [room, socketId]);

  const currentPlayer = room?.players?.[room?.currentTurnIndex ?? 0] ?? null;
  const isHost = room?.hostId === socketId;
  const gameStarted = Boolean(room?.started);
  const gameFinished = Boolean(room?.finished);
  const roundEnded = Boolean(room?.roundEnded);
  const waitingOnHeart = Boolean(room?.pendingHeartPlayerId);
  const isMyTurn = currentPlayer?.id === socketId;
  const canBank =
    gameStarted &&
    !gameFinished &&
    !room?.rolling &&
    !roundEnded &&
    !waitingOnHeart &&
    me?.eligible &&
    !me?.banked;
  const canRoll =
    gameStarted &&
    !gameFinished &&
    !room?.rolling &&
    !roundEnded &&
    !waitingOnHeart &&
    isMyTurn &&
    me?.eligible &&
    !me?.banked;
  const canUseMultiplier =
    gameStarted &&
    !gameFinished &&
    !room?.rolling &&
    !roundEnded &&
    !waitingOnHeart &&
    me?.eligible &&
    !me?.banked &&
    me?.hasMultiplier;
  const showHeartPrompt = room?.pendingHeartPlayerId === socketId;

  const handleCreateRoom = () => {
    if (!name.trim()) {
      setError(emptyNameMessage);
      return;
    }
    socket.emit("room:create", {
      name: name.trim(),
      totalRounds: roundsInput,
      token: playerToken,
    });
  };

  const handleJoinRoom = () => {
    if (!name.trim()) {
      setError(emptyNameMessage);
      return;
    }
    if (!roomCode.trim()) {
      setError("Enter a room code.");
      return;
    }
    socket.emit("room:join", {
      name: name.trim(),
      roomId: roomCode.trim().toUpperCase(),
      token: playerToken,
    });
  };

  const handleStart = () => {
    socket.emit("game:start");
  };

  const handleRestart = () => {
    socket.emit("game:restart");
  };

  const handleRoll = () => {
    rollAudioRef.current?.play?.().catch(() => {});
    socket.emit("game:roll");
  };

  const handleBank = () => {
    bankAudioRef.current?.play?.().catch(() => {});
    socket.emit("game:bank");
  };

  const handleUseMultiplier = () => {
    socket.emit("multiplier:use");
  };

  const handleReady = () => {
    socket.emit("round:ready");
  };

  const handleBuyItem = (itemId) => {
    socket.emit("shop:buy", { itemId });
  };

  const handleHeartDecision = (useHeart) => {
    socket.emit("heart:decision", { use: useHeart });
  };

  const handleLeaveRoom = () => {
    socket.emit("room:leave");
    clearSessionAndToken();
    setRoom(null);
    setHomeMode(null);
    setRoomCode("");
  };

  const handleKickPlayer = (playerId, playerName) => {
    setKickPrompt({ id: playerId, name: playerName || "this player" });
  };

  const confirmKick = () => {
    if (!kickPrompt?.id) {
      return;
    }
    socket.emit("room:kick", { playerId: kickPrompt.id });
    setKickPrompt(null);
  };

  const cancelKick = () => setKickPrompt(null);

  const closeRollModal = () => setRollModal(null);

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="eyebrow">Bank</p>
          <h1>Roll fast. Bank faster.</h1>
        </div>
        <div className="status">
          <span className={connected ? "dot online" : "dot offline"} />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </header>

      {!room ? (
        <section className="panel home-panel">
          <div className="panel-body">
            {!homeMode ? (
              <>
                <div className="choice-grid">
                  <button
                    className="choice-card primary"
                    onClick={() => setHomeMode("create")}
                  >
                    <span className="choice-title">Create room</span>
                    <span className="choice-desc">
                      Set the rounds and invite friends with a fresh code.
                    </span>
                  </button>
                  <button
                    className="choice-card"
                    onClick={() => setHomeMode("join")}
                  >
                    <span className="choice-title">Join room</span>
                    <span className="choice-desc">
                      Enter a code to jump into an existing table.
                    </span>
                  </button>
                </div>
                {error && <p className="error">{error}</p>}
              </>
            ) : (
              <div className="flow">
                <div className="flow-header">
                  <h2>
                    {homeMode === "create" ? "Create room" : "Join room"}
                  </h2>
                  <button
                    className="button ghost"
                    onClick={() => setHomeMode(null)}
                  >
                    Back
                  </button>
                </div>
                <div className="input-grid">
                  <label>
                    Your name
                    <input
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Dice Boss"
                      maxLength={18}
                    />
                  </label>
                  {homeMode === "create" ? (
                    <label>
                      Total rounds
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={roundsInput}
                        onChange={(event) =>
                          setRoundsInput(Number(event.target.value))
                        }
                      />
                    </label>
                  ) : (
                    <label>
                      Room code
                      <input
                        type="text"
                        value={roomCode}
                        onChange={(event) => setRoomCode(event.target.value)}
                        placeholder="ABCD"
                        maxLength={6}
                      />
                    </label>
                  )}
                </div>
                <div className="button-row">
                  {homeMode === "create" ? (
                    <button className="button primary" onClick={handleCreateRoom}>
                      Create room
                    </button>
                  ) : (
                    <button className="button primary" onClick={handleJoinRoom}>
                      Join room
                    </button>
                  )}
                </div>
                {error && <p className="error">{error}</p>}
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="room-stack">
          <div className="room-toolbar">
            <button
              className="button ghost leave-button"
              onClick={handleLeaveRoom}
            >
              <svg
                className="leave-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M10 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M16 16l4-4-4-4M20 12H9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Leave room</span>
            </button>
          </div>
          <div className="grid">
            {gameFinished && winners.length > 0 ? (
              <div className="panel main-panel win-panel">
                <div className="panel-body win-panel-body">
                  <p className="eyebrow">Winner</p>
                  <h2 className="win-title">
                    {winners.length === 1
                      ? winners[0].name
                      : winners.map((winner) => winner.name).join(" & ")}
                  </h2>
                  <p className="win-score">
                    {formatPot(winners[0]?.score ?? 0)}
                  </p>
                  {isHost && (
                    <button
                      className="button primary win-restart"
                      onClick={handleRestart}
                    >
                      Restart game
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="panel main-panel">
                <div className="panel-body">
                  <div className="room-meta">
                    <div>
                      <p className="eyebrow">Room code</p>
                      <h2>{room.id}</h2>
                    </div>
                    <div>
                      <p className="eyebrow">Rounds</p>
                      <h3>
                        {room.currentRound || 0}/{room.totalRounds}
                      </h3>
                    </div>
                  </div>

                  <div className="pot-highlight">
                    <div>
                      <p className="label">Pot</p>
                      <p className="pot-value">{formatPot(room.pot)}</p>
                    </div>
                  </div>

                  <div className="info-block">
                    <div>
                      <p className="label">Turn</p>
                      <p className="value">
                        {currentPlayer ? currentPlayer.name : "—"}
                      </p>
                    </div>
                  </div>

                  <div className="dice-wrap">
                    <div
                      className={`dice${room.rolling ? " rolling" : ""}`}
                    >
                      {room.lastRoll ?? "?"}
                    </div>
                    <p className="last-event">
                      {room.lastEvent || "Waiting for the first roll."}
                    </p>
                  </div>

                  <div className="controls">
                    {gameStarted ? (
                      <>
                        <button
                          className="button primary"
                          onClick={handleRoll}
                          disabled={!canRoll}
                        >
                          {isMyTurn ? "Roll" : "Waiting"}
                        </button>
                        <button
                          className="button ghost"
                          onClick={handleUseMultiplier}
                          disabled={!canUseMultiplier}
                        >
                          Use 2x
                        </button>
                        <button
                          className="button ghost"
                          onClick={handleBank}
                          disabled={!canBank}
                        >
                          Bank
                        </button>
                      </>
                    ) : (
                      <>
                        {isHost ? (
                          <button className="button primary" onClick={handleStart}>
                            Start game
                          </button>
                        ) : (
                          <p className="waiting">Waiting for host to start…</p>
                        )}
                      </>
                    )}
                  </div>

                  {me &&
                    !me.eligible &&
                    gameStarted &&
                    !gameFinished &&
                    !roundEnded && (
                      <p className="note">
                        You joined mid-round. You’ll be eligible next round.
                      </p>
                    )}
                  {error && <p className="error">{error}</p>}
                </div>
              </div>
            )}
            <div className="panel players-panel">
              <div className="panel-body">
                <h2>Players</h2>
                <ul className="players">
                  {room.players.map((player) => {
                    const isCurrent = player.id === currentPlayer?.id;
                    return (
                      <li
                        key={player.id}
                        className={`player ${
                          isCurrent ? "current" : ""
                        } ${player.banked ? "banked" : ""}`}
                      >
                        <div>
                          <p className="player-name">{player.name}</p>
                          <p className="player-meta">
                            {player.id === room.hostId ? "Host" : "Player"}
                            {player.id === socketId ? " · You" : ""}
                            {player.eligible ? "" : " · Next round"}
                          </p>
                        </div>
                        <div className="player-score">
                          <div className="player-score-main">
                            <span className="score-value">
                              {formatPot(player.score)}
                            </span>
                            {isHost && player.id !== room.hostId && (
                              <button
                                className="kick-button"
                                type="button"
                                onClick={() =>
                                  handleKickPlayer(player.id, player.name)
                                }
                              >
                                Kick
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="player-divider" />
                        <div className="player-subrow">
                          <div className="player-subrow-left">
                            <div className="player-icon-group">
                              <span className="player-icon-label">Hearts</span>
                              {renderHearts(player.hearts ?? 0)}
                            </div>
                            <div className="player-icon-group">
                              <span className="player-icon-label">2x</span>
                              {renderBolt(Boolean(player.hasMultiplier))}
                            </div>
                          </div>
                          <div className="player-subrow-right">
                            {gameStarted && isCurrent && !player.banked && (
                              <span className="player-status">Rolling</span>
                            )}
                            {roundEnded && player.readyForNextRound ? (
                              <span className="player-status ready">Ready</span>
                            ) : (
                              gameStarted &&
                              player.banked && (
                                <span className="player-status banked">
                                  Banked
                                </span>
                              )
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            <div className="panel history-panel">
              <div className="panel-body">
                <h2>Round history</h2>
                {me?.roundHistory && me.roundHistory.length > 0 ? (
                  <ul className="round-history">
                    {(showAllHistory
                      ? me.roundHistory
                      : me.roundHistory.slice(0, 3)
                    ).map((entry) => (
                      <li key={entry.id} className="round-history-item">
                        <div className="round-history-header">
                          <span className="round-history-title">
                            Round {entry.round ?? 0}
                          </span>
                          {entry.actualSequence &&
                            entry.actualSequence.length > 0 && (
                              <button
                                className="round-history-link"
                                type="button"
                                onClick={() => setRollModal(entry)}
                              >
                                View rolls
                              </button>
                            )}
                        </div>
                        <dl className="round-history-metrics">
                          <div className="round-history-metric">
                            <dt>Earnings</dt>
                            <dd>{formatPot(entry.points)}</dd>
                          </div>
                        </dl>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="history-empty">No rounds yet.</p>
                )}
                {me?.roundHistory && me.roundHistory.length > 3 && (
                  <button
                    className="round-history-toggle"
                    type="button"
                    onClick={() => setShowAllHistory((prev) => !prev)}
                  >
                    {showAllHistory ? "Show less" : "Show more"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
      {rollModal && (
        <div className="modal-scrim" onClick={closeRollModal}>
          <div
            className="modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Round {rollModal.round} roll history</h3>
              <button className="modal-close" onClick={closeRollModal}>
                Close
              </button>
            </div>
            <div className="modal-body">
              {rollModal.actualSequence &&
                rollModal.actualSequence.length > 0 && (
                  <div className="roll-group">
                    <div className="roll-group-header">
                      <span className="roll-group-title">Actual rolls</span>
                    </div>
                    <div className="roll-table">
                      <div className="roll-row roll-header">
                        <span>#</span>
                        <span>Roll</span>
                      </div>
                      {rollModal.actualSequence.map((roll, index) => (
                        <div
                          key={`actual-${roll}-${index}`}
                          className={`roll-row${
                            rollModal.bankIndex === index + 1 ? " banked" : ""
                          }`}
                        >
                          <span>{index + 1}</span>
                          <span
                            className={`roll-cell${roll === 1 ? " bust" : ""}`}
                          >
                            {roll}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}
      {showHeartPrompt && (
        <div className="modal-scrim">
          <div className="modal">
            <div className="modal-header">
              <h3>Use a heart?</h3>
              {renderHearts(me?.hearts ?? 0, "hearts-compact")}
            </div>
            <div className="modal-body">
              <p className="note">
                You rolled a 1. Use a heart to stay in the round?
              </p>
              <div className="modal-actions">
                <button
                  className="button primary"
                  onClick={() => handleHeartDecision(true)}
                >
                  Use heart
                </button>
                <button
                  className="button ghost"
                  onClick={() => handleHeartDecision(false)}
                >
                  Take the bust
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {kickPrompt && (
        <div className="modal-scrim" onClick={cancelKick}>
          <div
            className="modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Kick player?</h3>
              <button className="modal-close" onClick={cancelKick}>
                Close
              </button>
            </div>
            <div className="modal-body">
              <p className="note">
                Remove {kickPrompt.name} from the room?
              </p>
              <div className="modal-actions two-column">
                <button className="button ghost" onClick={cancelKick}>
                  Cancel
                </button>
                <button className="button danger" onClick={confirmKick}>
                  Kick
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {gameStarted && !gameFinished && roundEnded && (
        <div className="modal-scrim intermission-scrim">
          <div className="modal intermission">
            <div className="intermission-header">
              <div>
                <p className="label">End of round</p>
                <p className="intermission-title">
                  Ready up for round {room.currentRound + 1}
                </p>
              </div>
              <div className="intermission-meta">
                <div>
                  <p className="label">Balance</p>
                  <p className="value">{formatPot(me?.score ?? 0)}</p>
                </div>
                <div>
                  <p className="label">Hearts</p>
                  {renderHearts(me?.hearts ?? 0, "hearts-compact")}
                </div>
                <div>
                  <p className="label">2x Multiplier</p>
                  {renderBolt(Boolean(me?.hasMultiplier), "bolt-compact")}
                </div>
              </div>
            </div>
            <div className="intermission-actions">
              {(room?.shop ?? []).map((item) => {
                const ownedCount =
                  item.id === "heart"
                    ? me?.hearts ?? 0
                    : item.id === "multiplier"
                    ? me?.hasMultiplier
                      ? 1
                      : 0
                    : 0;
                const isMaxed =
                  typeof item.maxOwned === "number" &&
                  ownedCount >= item.maxOwned;
                const isAffordable = (me?.score ?? 0) >= item.price;
                return (
                  <button
                    key={item.id}
                    className="button ghost"
                    onClick={() => handleBuyItem(item.id)}
                    disabled={isMaxed || !isAffordable}
                    title={item.description}
                  >
                    {item.label} (${item.price})
                  </button>
                );
              })}
            </div>
            <button
              className="button primary intermission-ready"
              onClick={handleReady}
              disabled={me?.readyForNextRound}
            >
              {me?.readyForNextRound ? "Ready" : "Ready up"}
            </button>
            <p className="note">
              Everyone must be ready to continue the next round.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
