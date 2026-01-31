import crypto from "crypto";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const allowedOrigins = (process.env.CORS_ORIGIN ||
  "https://bank.dentonflake.com,http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

const rooms = new Map();

const rollDie = () => Math.floor(Math.random() * 6) + 1;

const simulatePossiblePot = (room) => {
  let pot = room.pot;
  let roundRolls = room.roundRolls;
  let isFirstRoll = roundRolls === 0;
  let simulatedRolls = 0;
  const simulatedSequence = [];

  while (true) {
    const roll = rollDie();
    simulatedRolls += 1;
    simulatedSequence.push(roll);
    if (isFirstRoll && roll === 1) {
      pot += 10;
      roundRolls += 1;
      isFirstRoll = false;
      continue;
    }

    if (roll === 1) {
      break;
    }

    if (isFirstRoll && roll === 2) {
      pot += 2;
      roundRolls += 1;
      isFirstRoll = false;
      continue;
    }

    if (roll === 2) {
      pot *= 2;
      roundRolls += 1;
      isFirstRoll = false;
      continue;
    }

    pot += roll;
    roundRolls += 1;
    isFirstRoll = false;
  }

  return { pot, simulatedRolls, simulatedSequence };
};

const makePlayerToken = () => crypto.randomUUID();

const makeRoomId = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
};

const toPublicRoom = (room) => ({
  id: room.id,
  hostId: room.hostId,
  players: room.players.map((player) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    banked: player.banked,
    eligible: player.eligible,
    connected: player.connected,
    roundHistory: player.roundHistory ?? [],
  })),
  started: room.started,
  finished: room.finished,
  totalRounds: room.totalRounds,
  currentRound: room.currentRound,
  pot: room.pot,
  currentTurnIndex: room.currentTurnIndex,
  isFirstRoll: room.isFirstRoll,
  rolling: room.rolling,
  lastRoll: room.lastRoll ?? null,
  lastRollPlayerId: room.lastRollPlayerId ?? null,
  lastEvent: room.lastEvent ?? "",
});

const emitRoom = (room) => {
  io.to(room.id).emit("room:state", toPublicRoom(room));
};

const isActivePlayer = (player) =>
  player.connected && player.eligible && !player.banked;

const firstEligibleUnbankedIndex = (room) => {
  for (let i = 0; i < room.players.length; i += 1) {
    const player = room.players[i];
    if (isActivePlayer(player)) {
      return i;
    }
  }
  return -1;
};

const hasEligibleUnbanked = (room) =>
  room.players.some((player) => isActivePlayer(player));

const startRound = (room, roundNumber) => {
  room.currentRound = roundNumber;
  room.pot = 0;
  room.isFirstRoll = true;
  room.roundRolls = 0;
  room.roundRollSequence = [];
  room.rolling = false;
  room.players.forEach((player) => {
    if (player.connected) {
      player.eligible = true;
      player.banked = false;
    }
    player.roundPoints = 0;
    player.roundBankIndex = null;
    player.participatedInRound = player.connected;
  });
  room.currentTurnIndex = firstEligibleUnbankedIndex(room);
  room.lastEvent = `Round ${room.currentRound} started.`;
};

const endGame = (room) => {
  room.finished = true;
  room.started = true;
  room.rolling = false;
  room.pot = 0;
  room.lastEvent = `Game over after ${room.totalRounds} rounds.`;
};

const endRound = (room, reason) => {
  const roundEndPot = room.pot;
  const simulated =
    reason === "allBanked" ? simulatePossiblePot(room) : null;
  const possiblePot = simulated ? simulated.pot : roundEndPot;
  const simulatedRolls = simulated ? simulated.simulatedRolls : 0;
  const simulatedSequence = simulated ? simulated.simulatedSequence : [];
  const actualSequence = room.roundRollSequence || [];
  const roundNumber = room.currentRound;
  room.players.forEach((player) => {
    if (!player.participatedInRound) {
      return;
    }
    const possible = possiblePot;
    const points = player.roundPoints || 0;
    const percent =
      possible > 0 ? Math.round((points / possible) * 100) : 0;
    player.roundHistory = [
      {
        id: `${roundNumber}-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`,
        round: roundNumber,
        points,
        possible,
        percent,
        simulatedRolls,
        simulatedSequence,
        actualSequence,
        bankIndex: player.roundBankIndex,
      },
      ...(player.roundHistory || []),
    ].slice(0, 10);
    player.roundPoints = 0;
    player.roundBankIndex = null;
    player.participatedInRound = false;
  });

  if (reason === "bust") {
    room.players.forEach((player) => {
      if (player.eligible) {
        player.banked = true;
      }
    });
    room.lastEvent = `Round ${room.currentRound} busted on a 1.`;
  } else {
    room.lastEvent = `Round ${room.currentRound} ended (all banked).`;
  }

  if (room.currentRound >= room.totalRounds) {
    endGame(room);
  } else {
    startRound(room, room.currentRound + 1);
  }
};

const advanceTurn = (room) => {
  if (!hasEligibleUnbanked(room)) {
    endRound(room, "allBanked");
    return;
  }

  if (room.players.length === 0) {
    return;
  }

  const totalPlayers = room.players.length;
  let nextIndex = room.currentTurnIndex;

  for (let i = 0; i < totalPlayers; i += 1) {
    nextIndex = (nextIndex + 1) % totalPlayers;
    const candidate = room.players[nextIndex];
    if (candidate.eligible && !candidate.banked) {
      room.currentTurnIndex = nextIndex;
      return;
    }
  }
};

const ensureValidTurn = (room) => {
  if (!room.started || room.finished) {
    return;
  }

  if (!hasEligibleUnbanked(room)) {
    endRound(room, "allBanked");
    return;
  }

  const current = room.players[room.currentTurnIndex];
  if (!current || !current.eligible || current.banked) {
    const nextIndex = firstEligibleUnbankedIndex(room);
    if (nextIndex !== -1) {
      room.currentTurnIndex = nextIndex;
    }
  }
};

const createRoom = ({ hostId, hostName, totalRounds }) => {
  let id = makeRoomId();
  while (rooms.has(id)) {
    id = makeRoomId();
  }

  const hostToken = makePlayerToken();
  const room = {
    id,
    hostId,
    players: [
      {
        id: hostId,
        name: hostName,
        score: 0,
        banked: false,
        eligible: true,
        connected: true,
        token: hostToken,
        roundHistory: [],
        roundPoints: 0,
        roundBankIndex: null,
        participatedInRound: true,
      },
    ],
    started: false,
    finished: false,
    totalRounds: totalRounds || 10,
    currentRound: 0,
    pot: 0,
    currentTurnIndex: 0,
    isFirstRoll: true,
    roundRolls: 0,
    roundRollSequence: [],
    rolling: false,
    lastRoll: null,
    lastRollPlayerId: null,
    lastEvent: "Room created.",
  };

  rooms.set(id, room);
  return room;
};

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, totalRounds, token }) => {
    if (!name) {
      socket.emit("room:error", "Name is required.");
      return;
    }

    const room = createRoom({
      hostId: socket.id,
      hostName: name,
      totalRounds: Number(totalRounds) || 10,
    });

    const host = room.players.find((player) => player.id === socket.id);
    if (host) {
      host.token = token || host.token || makePlayerToken();
    }

    socket.data.roomId = room.id;
    socket.join(room.id);
    emitRoom(room);
  });

  socket.on("room:reconnect", ({ roomId, name, token }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("room:error", "Room not found.");
      return;
    }

    if (!token) {
      socket.emit("room:error", "Missing reconnect token.");
      return;
    }

    const existingPlayer = room.players.find((player) => player.token === token);
    if (!existingPlayer) {
      socket.emit("room:error", "Reconnect failed.");
      return;
    }

    if (room.hostId === existingPlayer.id) {
      room.hostId = socket.id;
    }

    existingPlayer.id = socket.id;
    existingPlayer.name = name || existingPlayer.name;
    existingPlayer.connected = true;

    socket.data.roomId = room.id;
    socket.join(room.id);

    room.lastEvent = `${existingPlayer.name} reconnected.`;
    ensureValidTurn(room);
    emitRoom(room);
  });

  socket.on("room:join", ({ roomId, name, token }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("room:error", "Room not found.");
      return;
    }

    if (!name) {
      socket.emit("room:error", "Name is required.");
      return;
    }

    if (token) {
      const existingPlayer = room.players.find(
        (player) => player.token === token
      );
      if (existingPlayer) {
        if (room.hostId === existingPlayer.id) {
          room.hostId = socket.id;
        }
        existingPlayer.id = socket.id;
        existingPlayer.name = name || existingPlayer.name;
        existingPlayer.connected = true;
        socket.data.roomId = room.id;
        socket.join(room.id);
        room.lastEvent = `${existingPlayer.name} reconnected.`;
        ensureValidTurn(room);
        emitRoom(room);
        return;
      }
    }

    const player = {
      id: socket.id,
      name,
      score: 0,
      banked: room.started && !room.finished,
      eligible: !(room.started && !room.finished),
      connected: true,
      token: token || makePlayerToken(),
      roundHistory: [],
      roundPoints: 0,
      roundBankIndex: null,
      participatedInRound: false,
    };

    room.players.push(player);
    socket.data.roomId = room.id;
    socket.join(room.id);

    if (room.started && !room.finished) {
      room.lastEvent = `${name} joined and will play next round.`;
    } else {
      room.lastEvent = `${name} joined the room.`;
    }

    ensureValidTurn(room);
    emitRoom(room);
  });

  socket.on("room:leave", () => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.data.roomId = null;
      return;
    }

    const leavingIndex = room.players.findIndex((p) => p.id === socket.id);
    if (leavingIndex === -1) {
      socket.data.roomId = null;
      return;
    }

    const [leavingPlayer] = room.players.splice(leavingIndex, 1);
    room.lastEvent = `${leavingPlayer.name} left the room.`;

    if (room.players.length === 0) {
      rooms.delete(roomId);
      socket.data.roomId = null;
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      room.lastEvent = `${room.players[0].name} is now the host.`;
    }

    if (leavingIndex < room.currentTurnIndex) {
      room.currentTurnIndex = Math.max(0, room.currentTurnIndex - 1);
    } else if (leavingIndex === room.currentTurnIndex) {
      room.currentTurnIndex = Math.max(0, room.currentTurnIndex - 1);
      advanceTurn(room);
    }

    ensureValidTurn(room);
    socket.data.roomId = null;
    socket.leave(roomId);
    emitRoom(room);
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("room:error", "Only the host can start the game.");
      return;
    }

    if (room.started && !room.finished) {
      socket.emit("room:error", "Game already started.");
      return;
    }

    room.started = true;
    room.finished = false;
    room.players.forEach((player) => {
      player.score = 0;
      player.roundHistory = [];
      player.roundPoints = 0;
      player.roundBankIndex = null;
      player.participatedInRound = false;
    });
    startRound(room, 1);
    emitRoom(room);
  });

  socket.on("game:restart", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("room:error", "Only the host can restart the game.");
      return;
    }

    room.started = true;
    room.finished = false;
    room.players.forEach((player) => {
      player.score = 0;
      player.roundHistory = [];
      player.roundPoints = 0;
      player.roundBankIndex = null;
      player.participatedInRound = false;
    });
    startRound(room, 1);
    emitRoom(room);
  });

  socket.on("game:bank", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished) {
      return;
    }

    if (room.rolling) {
      socket.emit("room:error", "Cannot bank during a roll.");
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.eligible || player.banked) {
      return;
    }

    player.score += room.pot;
    player.banked = true;
    player.roundPoints = room.pot;
    player.roundBankIndex = room.roundRollSequence.length;
    room.lastEvent = `${player.name} banked ${room.pot} points.`;

    if (!hasEligibleUnbanked(room)) {
      endRound(room, "allBanked");
    } else if (room.players[room.currentTurnIndex]?.id === player.id) {
      advanceTurn(room);
    }

    emitRoom(room);
  });

  socket.on("game:roll", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished) {
      return;
    }

    if (room.rolling) {
      return;
    }

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit("room:error", "It is not your turn.");
      return;
    }

    if (!currentPlayer.eligible || currentPlayer.banked) {
      return;
    }

    room.rolling = true;
    room.lastEvent = `${currentPlayer.name} is rolling...`;
    emitRoom(room);

    setTimeout(() => {
      if (!rooms.has(room.id)) {
        return;
      }

      const activeRoom = rooms.get(room.id);
      if (!activeRoom || activeRoom.finished) {
        return;
      }

      const roll = rollDie();
      const isFirstRoll = activeRoom.roundRolls === 0;
      activeRoom.lastRoll = roll;
      activeRoom.lastRollPlayerId = currentPlayer.id;
      activeRoom.rolling = false;
      activeRoom.roundRollSequence.push(roll);

      if (isFirstRoll && roll === 1) {
        activeRoom.pot += 10;
        activeRoom.roundRolls += 1;
        activeRoom.isFirstRoll = false;
        activeRoom.lastEvent = `${currentPlayer.name} rolled a 1 (first roll) for 10 points.`;
        advanceTurn(activeRoom);
        emitRoom(activeRoom);
        return;
      }

      if (roll === 1) {
        activeRoom.roundRolls += 1;
        activeRoom.isFirstRoll = false;
        activeRoom.lastEvent = `${currentPlayer.name} rolled a 1 — bust.`;
        endRound(activeRoom, "bust");
        emitRoom(activeRoom);
        return;
      }

      if (isFirstRoll && roll === 2) {
        activeRoom.pot += 2;
        activeRoom.roundRolls += 1;
        activeRoom.isFirstRoll = false;
        activeRoom.lastEvent = `${currentPlayer.name} rolled a 2 (first roll) for 2 points.`;
        advanceTurn(activeRoom);
        emitRoom(activeRoom);
        return;
      }

      if (roll === 2) {
        activeRoom.pot = activeRoom.pot * 2;
        activeRoom.roundRolls += 1;
        activeRoom.isFirstRoll = false;
        activeRoom.lastEvent = `${currentPlayer.name} rolled a 2 — pot doubled.`;
        advanceTurn(activeRoom);
        emitRoom(activeRoom);
        return;
      }

      activeRoom.pot += roll;
      activeRoom.roundRolls += 1;
      activeRoom.isFirstRoll = false;
      activeRoom.lastEvent = `${currentPlayer.name} rolled a ${roll}.`;
      advanceTurn(activeRoom);
      emitRoom(activeRoom);
    }, 900);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    const leavingIndex = room.players.findIndex((p) => p.id === socket.id);
    if (leavingIndex === -1) {
      return;
    }

    const leavingPlayer = room.players[leavingIndex];
    leavingPlayer.connected = false;
    room.lastEvent = `${leavingPlayer.name} disconnected.`;

    if (room.players.every((player) => !player.connected)) {
      emitRoom(room);
      return;
    }

    if (leavingIndex === room.currentTurnIndex) {
      advanceTurn(room);
    }

    ensureValidTurn(room);
    emitRoom(room);
  });
});

app.get("/", (_req, res) => {
  res.send("Bank server is running.");
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
httpServer.listen(PORT, HOST, () => {
  console.log(`Bank server listening on http://${HOST}:${PORT}`);
});
