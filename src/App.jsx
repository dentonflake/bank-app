import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const serverUrl = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

const socket = io(serverUrl, {
  autoConnect: false,
});

const emptyNameMessage = "Enter your name to continue.";

function App() {
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState("");
  const [room, setRoom] = useState(null);
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [roundsInput, setRoundsInput] = useState(10);
  const [homeMode, setHomeMode] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    socket.connect();

    const handleConnect = () => {
      setConnected(true);
      setSocketId(socket.id);
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
      setTimeout(() => setError(""), 2500);
    });

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("room:state");
      socket.off("room:error");
      socket.disconnect();
    };
  }, []);

  const me = useMemo(() => {
    if (!room) return null;
    return room.players.find((player) => player.id === socketId) || null;
  }, [room, socketId]);

  const currentPlayer = room?.players?.[room?.currentTurnIndex ?? 0] ?? null;
  const isHost = room?.hostId === socketId;
  const gameStarted = Boolean(room?.started);
  const gameFinished = Boolean(room?.finished);
  const isMyTurn = currentPlayer?.id === socketId;
  const canBank =
    gameStarted &&
    !gameFinished &&
    !room?.rolling &&
    me?.eligible &&
    !me?.banked;
  const canRoll =
    gameStarted &&
    !gameFinished &&
    !room?.rolling &&
    isMyTurn &&
    me?.eligible &&
    !me?.banked;

  const handleCreateRoom = () => {
    if (!name.trim()) {
      setError(emptyNameMessage);
      return;
    }
    socket.emit("room:create", {
      name: name.trim(),
      totalRounds: roundsInput,
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
    });
  };

  const handleStart = () => {
    socket.emit("game:start");
  };

  const handleRestart = () => {
    socket.emit("game:restart");
  };

  const handleRoll = () => {
    socket.emit("game:roll");
  };

  const handleBank = () => {
    socket.emit("game:bank");
  };

  const handleRoundsUpdate = () => {
    socket.emit("room:setRounds", { totalRounds: roundsInput });
  };

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
                    className="choice-card"
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
        <section className="grid">
          <div className="panel">
            <div className="panel-body">
              <div className="room-meta">
                <div>
                  <p className="eyebrow">Room</p>
                  <h2>{room.id}</h2>
                </div>
                <div>
                  <p className="eyebrow">Rounds</p>
                  <h3>
                    {room.currentRound || 0}/{room.totalRounds}
                  </h3>
                </div>
              </div>

              <div className="info-block">
                <div>
                  <p className="label">Pot</p>
                  <p className="value">{room.pot}</p>
                </div>
                <div>
                  <p className="label">Turn</p>
                  <p className="value">
                    {currentPlayer ? currentPlayer.name : "—"}
                  </p>
                </div>
                <div>
                  <p className="label">Status</p>
                  <p className="value">
                    {room.rolling
                      ? "Rolling"
                      : gameFinished
                      ? "Finished"
                      : gameStarted
                      ? "Live"
                      : "Lobby"}
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
                      onClick={handleBank}
                      disabled={!canBank}
                    >
                      Bank
                    </button>
                  </>
                ) : (
                  <>
                    {isHost ? (
                      <>
                        <div className="rounds-control">
                          <label>
                            Rounds
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
                          <button
                            className="button ghost"
                            onClick={handleRoundsUpdate}
                          >
                            Update
                          </button>
                        </div>
                        <button className="button primary" onClick={handleStart}>
                          Start game
                        </button>
                      </>
                    ) : (
                      <p className="waiting">Waiting for host to start…</p>
                    )}
                  </>
                )}

                {gameFinished && isHost && (
                  <button className="button primary" onClick={handleRestart}>
                    Restart game
                  </button>
                )}
              </div>

              {me && !me.eligible && (
                <p className="note">
                  You joined mid-round. You’ll be eligible next round.
                </p>
              )}
              {error && <p className="error">{error}</p>}
            </div>
          </div>

          <div className="panel">
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
                        <span>{player.score}</span>
                        {gameStarted && player.banked && (
                          <span className="badge">Banked</span>
                        )}
                        {gameStarted && isCurrent && !player.banked && (
                          <span className="badge live">Rolling</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export default App;
