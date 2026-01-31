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

const shopCatalog = [
  {
    id: "heart",
    label: "Heart",
    description: "Save yourself from a non-first-roll 1.",
    price: 100,
    maxOwned: 3,
  },
  {
    id: "multiplier",
    label: "2x Multiplier",
    description: "Instantly double the pot once per round.",
    price: 5,
    maxOwned: 1,
  },
];

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
    hearts: player.hearts ?? 0,
    hasMultiplier: player.hasMultiplier ?? false,
    readyForNextRound: player.readyForNextRound ?? false,
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
  roundEnded: room.roundEnded ?? false,
  pendingHeartPlayerId: room.pendingHeart?.playerId ?? null,
  lastBustId: room.lastBust?.id ?? 0,
  lastBustPlayerIds: room.lastBust?.playerIds ?? [],
  shop: shopCatalog,
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

const firstEligibleUnbankedFromIndex = (room, startIndex) => {
  if (room.players.length === 0) {
    return -1;
  }
  const totalPlayers = room.players.length;
  let index = startIndex;
  for (let i = 0; i < totalPlayers; i += 1) {
    const player = room.players[index];
    if (isActivePlayer(player)) {
      return index;
    }
    index = (index + 1) % totalPlayers;
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
  room.roundEnded = false;
  room.pendingHeart = null;
  room.players.forEach((player) => {
    if (player.connected) {
      player.eligible = true;
      player.banked = false;
    }
    player.readyForNextRound = false;
    player.roundPoints = 0;
    player.roundBankIndex = null;
    player.participatedInRound = player.connected;
  });
  const startingIndex =
    typeof room.nextStartIndex === "number" ? room.nextStartIndex : 0;
  room.currentTurnIndex = firstEligibleUnbankedFromIndex(room, startingIndex);
  room.nextStartIndex = null;
  room.lastEvent = `Round ${room.currentRound} started.`;
};

const endGame = (room) => {
  room.finished = true;
  room.started = true;
  room.rolling = false;
  room.pot = 0;
  room.roundEnded = false;
  room.pendingHeart = null;
  room.lastEvent = `Game over after ${room.totalRounds} rounds.`;
};

const endRound = (room, reason) => {
  const actualSequence = room.roundRollSequence || [];
  const roundNumber = room.currentRound;
  room.players.forEach((player) => {
    if (!player.participatedInRound) {
      return;
    }
    const points = player.roundPoints || 0;
    player.roundHistory = [
      {
        id: `${roundNumber}-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`,
        round: roundNumber,
        points,
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
    room.lastBust = {
      id: (room.lastBust?.id ?? 0) + 1,
      playerIds: room.players
        .filter((player) => player.eligible && !player.banked)
        .map((player) => player.id),
    };
    room.players.forEach((player) => {
      if (player.eligible) {
        player.banked = true;
      }
    });
    room.lastEvent = `Round ${room.currentRound} busted on a 1.`;
  } else {
    room.lastEvent = `Round ${room.currentRound} ended (all banked).`;
  }

  const totalPlayers = room.players.length;
  if (totalPlayers > 0) {
    const lastRollIndex =
      room.lastRollPlayerId != null
        ? room.players.findIndex((p) => p.id === room.lastRollPlayerId)
        : room.currentTurnIndex;
    const baseIndex = lastRollIndex >= 0 ? lastRollIndex : room.currentTurnIndex;
    room.nextStartIndex = (baseIndex + 1) % totalPlayers;
  }

  if (room.currentRound >= room.totalRounds) {
    endGame(room);
    return;
  }

  room.roundEnded = true;
  room.pendingHeart = null;
  room.rolling = false;
  room.players.forEach((player) => {
    player.eligible = false;
    player.banked = true;
    player.readyForNextRound = !player.connected;
  });
  room.currentTurnIndex = 0;
};

const advanceTurn = (room) => {
  if (room.roundEnded || room.pendingHeart) {
    return;
  }

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

  if (room.roundEnded || room.pendingHeart) {
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
        hearts: 0,
        hasMultiplier: false,
        readyForNextRound: false,
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
    roundEnded: false,
    pendingHeart: null,
    lastBust: { id: 0, playerIds: [] },
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
    if (room.roundEnded) {
      existingPlayer.readyForNextRound = false;
    }

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
      hearts: 0,
      hasMultiplier: false,
      readyForNextRound: false,
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

    if (room.pendingHeart?.playerId === leavingPlayer.id) {
      room.pendingHeart = null;
      endRound(room, "bust");
      emitRoom(room);
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

  socket.on("room:kick", ({ playerId }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("room:error", "Only the host can kick players.");
      return;
    }

    if (!playerId || playerId === room.hostId) {
      return;
    }

    const kickedIndex = room.players.findIndex((p) => p.id === playerId);
    if (kickedIndex === -1) {
      return;
    }

    const [kickedPlayer] = room.players.splice(kickedIndex, 1);
    room.lastEvent = `${kickedPlayer.name} was kicked from the room.`;

    if (room.players.length === 0) {
      rooms.delete(room.id);
      return;
    }

    if (kickedIndex < room.currentTurnIndex) {
      room.currentTurnIndex = Math.max(0, room.currentTurnIndex - 1);
    } else if (kickedIndex === room.currentTurnIndex) {
      room.currentTurnIndex = Math.max(0, room.currentTurnIndex - 1);
      advanceTurn(room);
    }

    if (room.pendingHeart?.playerId === kickedPlayer.id) {
      room.pendingHeart = null;
      endRound(room, "bust");
    }

    ensureValidTurn(room);
    io.to(kickedPlayer.id).emit("room:kicked");
    io.sockets.sockets.get(kickedPlayer.id)?.leave(room.id);
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
      player.hearts = 0;
      player.hasMultiplier = false;
      player.readyForNextRound = false;
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
      player.hearts = 0;
      player.hasMultiplier = false;
      player.readyForNextRound = false;
    });
    startRound(room, 1);
    emitRoom(room);
  });

  socket.on("game:bank", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished) {
      return;
    }

    if (room.roundEnded || room.pendingHeart) {
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

    if (room.roundEnded || room.pendingHeart) {
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
        const activePlayer = activeRoom.players.find(
          (player) => player.id === currentPlayer.id
        );
        if (activePlayer && activePlayer.hearts > 0) {
          activeRoom.pendingHeart = {
            playerId: currentPlayer.id,
          };
          activeRoom.lastEvent = `${currentPlayer.name} rolled a 1 — heart decision.`;
          emitRoom(activeRoom);
          return;
        }

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

  socket.on("round:ready", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished || !room.roundEnded) {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.connected) {
      return;
    }

    player.readyForNextRound = true;
    room.lastEvent = `${player.name} is ready.`;

    const connectedPlayers = room.players.filter((p) => p.connected);
    const allReady =
      connectedPlayers.length > 0 &&
      connectedPlayers.every((p) => p.readyForNextRound);
    if (allReady) {
      startRound(room, room.currentRound + 1);
    }

    emitRoom(room);
  });

  socket.on("heart:buy", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished || !room.roundEnded) {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.connected) {
      return;
    }

    if (player.hearts >= 3) {
      socket.emit("room:error", "You already have 3 hearts.");
      return;
    }

    if (player.score < 100) {
      socket.emit("room:error", "Not enough funds to buy a heart.");
      return;
    }

    player.score -= 100;
    player.hearts += 1;
    room.lastEvent = `${player.name} bought a heart.`;
    emitRoom(room);
  });

  socket.on("heart:decision", ({ use }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished) {
      return;
    }

    if (!room.pendingHeart) {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || room.pendingHeart.playerId !== player.id) {
      return;
    }

    if (use && player.hearts > 0) {
      player.hearts -= 1;
      room.pendingHeart = null;
      room.lastEvent = `${player.name} used a heart.`;
      advanceTurn(room);
      emitRoom(room);
      return;
    }

    room.pendingHeart = null;
    endRound(room, "bust");
    emitRoom(room);
  });

  socket.on("multiplier:buy", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished || !room.roundEnded) {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.connected) {
      return;
    }

    if (player.hasMultiplier) {
      socket.emit("room:error", "You already have a 2x multiplier.");
      return;
    }

    if (player.score < 5) {
      socket.emit("room:error", "Not enough funds to buy a 2x multiplier.");
      return;
    }

    player.score -= 5;
    player.hasMultiplier = true;
    room.lastEvent = `${player.name} bought a 2x multiplier.`;
    emitRoom(room);
  });

  socket.on("shop:buy", ({ itemId }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished || !room.roundEnded) {
      return;
    }

    const item = shopCatalog.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.connected) {
      return;
    }

    if (player.score < item.price) {
      socket.emit("room:error", "Not enough funds to buy that item.");
      return;
    }

    if (item.id === "heart") {
      if (player.hearts >= item.maxOwned) {
        socket.emit("room:error", "You already have the max hearts.");
        return;
      }
      player.score -= item.price;
      player.hearts += 1;
      room.lastEvent = `${player.name} bought a heart.`;
      emitRoom(room);
      return;
    }

    if (item.id === "multiplier") {
      if (player.hasMultiplier) {
        socket.emit("room:error", "You already have a 2x multiplier.");
        return;
      }
      player.score -= item.price;
      player.hasMultiplier = true;
      room.lastEvent = `${player.name} bought a 2x multiplier.`;
      emitRoom(room);
    }
  });

  socket.on("multiplier:use", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.finished) {
      return;
    }

    if (room.roundEnded || room.pendingHeart || room.rolling) {
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.eligible || player.banked || !player.hasMultiplier) {
      return;
    }

    player.hasMultiplier = false;
    room.pot = room.pot * 2;
    room.lastEvent = `${player.name} used a 2x multiplier — pot doubled.`;
    emitRoom(room);
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
    if (room.roundEnded) {
      leavingPlayer.readyForNextRound = true;
    }
    room.lastEvent = `${leavingPlayer.name} disconnected.`;

    if (room.pendingHeart?.playerId === leavingPlayer.id) {
      room.pendingHeart = null;
      endRound(room, "bust");
      emitRoom(room);
      return;
    }

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
