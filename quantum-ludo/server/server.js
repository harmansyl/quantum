// FINAL server.js (clean, stable, correct)

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://quantum-ludo.onrender.com", // <-- Replace with your deployed frontend URL
  ],
  credentials: true
}));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://quantum-ludo.onrender.com", // <-- Replace with your deployed frontend URL
    ],
    credentials: true,
    methods: ["GET", "POST"]
  }
});

const COLORS = ["blue", "red", "green", "yellow"];
const TWO_PLAYER_ORDER = ["blue", "green"];
const THREE_PLAYER_ORDER = ["blue", "red", "green"];
const FOUR_PLAYER_ORDER = ["blue", "red", "green", "yellow"];

let rooms = {};

/**
 * Sorts players into clockwise turn order based on number of players
 */
function getPlayersByTurnOrder(players) {
  const count = players.length;
  let colorOrder;
  
  if (count === 2) {
    colorOrder = TWO_PLAYER_ORDER;
  } else if (count === 3) {
    colorOrder = THREE_PLAYER_ORDER;
  } else {
    colorOrder = FOUR_PLAYER_ORDER;
  }

  return [...players].sort(
    (a, b) => colorOrder.indexOf(a.color) - colorOrder.indexOf(b.color)
  );
}

function createPlayer(socket, name, color, isHost = false) {
  return {
    id: socket.id,
    name,
    color,
    isHost,
    tokens: [-1, -1, -1, -1],
  };
}

io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  socket.on("createRoom", ({ username, roomCode }) => {
    console.log("📥 CreateRoom:", { username, roomCode });

    if (!roomCode) return socket.emit("errorMessage", "Invalid roomCode");

    if (rooms[roomCode]) {
      return socket.emit("errorMessage", "Room already exists!");
    }

    rooms[roomCode] = {
      players: [],
      dice: 1,
      turnIndex: 0,
      isStarted: false,
    };

    const player = createPlayer(socket, username, "blue", true);
    rooms[roomCode].players.push(player);
    console.log(`✅ Room created: ${roomCode}, Player 1 assigned BLUE`);

    socket.join(roomCode);

    socket.emit("roomCreated", { roomCode });
    io.to(roomCode).emit("roomUpdate", rooms[roomCode].players);
  });

  socket.on("joinRoom", ({ username, roomCode }) => {
    console.log("📥 JoinRoom:", { username, roomCode });

    const room = rooms[roomCode];
    if (!room) return socket.emit("errorMessage", "Room does not exist!");

    if (room.players.length >= 4)
      return socket.emit("errorMessage", "Room full!");

    const usedColors = new Set(room.players.map((p) => p.color));
    let assignedColor = null;
    
    // Assign colors in order: red, green, yellow (blue is always host)
    const colorOrder = ["red", "green", "yellow"];
    for (const color of colorOrder) {
      if (!usedColors.has(color)) {
        assignedColor = color;
        break;
      }
    }

    if (!assignedColor) {
      return socket.emit("errorMessage", "No colors available!");
    }

    const player = createPlayer(socket, username, assignedColor);
    room.players.push(player);
    console.log(`✅ Player joined room ${roomCode}: ${assignedColor.toUpperCase()}`);

    socket.join(roomCode);

    socket.emit("roomJoined", { roomCode, color: assignedColor });
    io.to(roomCode).emit("roomUpdate", room.players);
  });
console.log("⚠️ RUNNING SERVER VERSION: V25");

  socket.on("startMatch", (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    console.log(`🎮 Before sort in ${roomCode}:`, room.players.map(p => p.color));
    
    // Sort players into proper turn order based on player count
    const orderedPlayers = getPlayersByTurnOrder(room.players);
    room.players = orderedPlayers;
    room.isStarted = true;
    room.turnIndex = 0;

    console.log(`🎮 After sort in ${roomCode}:`, room.players.map(p => p.color));
    console.log(`🎮 Match started in ${roomCode}:`, {
      players: room.players.map(p => `${p.color}(${p.name})`),
      turnOrder: room.players.map(p => p.color),
    });

    io.to(roomCode).emit("matchStarted", {
      ...room,
      turnOrder: room.players.map(p => p.id),
    });
  });

  socket.on("rollDice", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const current = room.players[room.turnIndex];
    if (!current || socket.id !== current.id)
      return socket.emit("errorMessage", "Not your turn!");

    const dice = Math.floor(Math.random() * 6) + 1;
    room.dice = dice;

    io.to(roomId).emit("diceRolled", {
      roomId,
      value: dice,
      player: current.color,
      roller: socket.id,
    });

    // Advance turn to next player (wraps around based on number of players)
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
  });

  socket.on("disconnect", () => {
    console.log("🔌 Disconnected:", socket.id);

    for (const [roomCode, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);

        io.to(roomCode).emit("roomUpdate", room.players);

        if (room.players.length === 0) {
          delete rooms[roomCode];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
