const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 520;
const GROUND_Y = 440;
const GOAL_TOP = 170;
const GOAL_BOTTOM = 330;
const GRAVITY = 0.52;

let players = {};
let p1Score = 0;
let p2Score = 0;
let rallyCount = 0;

const ball = {
  x: CANVAS_WIDTH / 2,
  y: 160,
  vx: 0,
  vy: 0,
  radius: 14,
  baseSpeed: 7,
  speedMultiplier: 1.0,
  lastHitter: null,
  inPlay: false
};

function resetBall(serveTo = 1) {
  ball.inPlay = false;
  ball.x = CANVAS_WIDTH / 2;
  ball.y = 160;
  ball.vx = 0;
  ball.vy = 0;
  ball.speedMultiplier = 1.0;
  ball.lastHitter = null;
  rallyCount = 0;

  io.emit('scoreUpdate', { p1Score, p2Score, rallyCount, speedMultiplier: ball.speedMultiplier });

  setTimeout(() => {
    ball.vx = serveTo * (ball.baseSpeed + (Math.random() * 2 - 1));
    ball.vy = -4 - Math.random() * 2;
    ball.inPlay = true;
  }, 900);
}

io.on('connection', (socket) => {
  const existingTypes = Object.values(players).map(p => p.type);
  let assignedRole = null;

  if (!existingTypes.includes('thief')) {
    assignedRole = 'thief';
  } else if (!existingTypes.includes('samurai')) {
    assignedRole = 'samurai';
  } else {
    assignedRole = 'spectator';
  }

  const isThief = assignedRole === 'thief';
  players[socket.id] = {
    id: socket.id,
    type: assignedRole,
    x: isThief ? 160 : 720,
    y: 300,
    width: 75,
    height: 120,
    vx: 0,
    vy: 0,
    speed: 6.4,
    jumpForce: -15,
    isGrounded: false,
    isSwinging: false,
    swingTimer: 0,
    minX: isThief ? 35 : CANVAS_WIDTH * 0.52,
    maxX: isThief ? CANVAS_WIDTH * 0.48 : CANVAS_WIDTH - 110
  };

  socket.emit('roleAssigned', { role: assignedRole });

  // İki oyuncu tamamlandığında topu başlat
  const activeCount = Object.values(players).filter(p => p.type !== 'spectator').length;
  if (activeCount >= 2 && !ball.inPlay && ball.vx === 0) {
    resetBall(1);
  }

  // Oyuncu Girişleri
  socket.on('playerInput', (input) => {
    const p = players[socket.id];
    if (!p || p.type === 'spectator') return;

    p.vx = 0;
    if (input.left) p.vx = -p.speed;
    if (input.right) p.vx = p.speed;
    if (input.jump && p.isGrounded) {
      p.vy = p.jumpForce;
      p.isGrounded = false;
    }

    if (input.swing && !p.isSwinging) {
      p.isSwinging = true;
      p.swingTimer = 0;
      io.emit('playerSwing', { type: p.type, swingType: input.swingType });

      // Hitbox Kontrolü
      const hitBoxX = p.type === 'thief' ? p.x + p.width - 25 : p.x - 85;
      const hitBoxW = 110;
      const hitBoxY = p.y - 35;
      const hitBoxH = p.height + 55;

      if (
        ball.inPlay &&
        ball.x > hitBoxX && ball.x < hitBoxX + hitBoxW &&
        ball.y > hitBoxY && ball.y < hitBoxY + hitBoxH
      ) {
        rallyCount++;
        ball.speedMultiplier = Math.min(2.5, ball.speedMultiplier + 0.06);
        ball.lastHitter = p.type;

        const dir = p.type === 'thief' ? 1 : -1;
        if (input.swingType === 'high') {
          ball.vx = dir * 9.2;
          ball.vy = -12.5;
        } else {
          ball.vx = dir * 14.5;
          ball.vy = -1.8;
        }

        io.emit('ballHit', { x: ball.x, y: ball.y, swingType: input.swingType, rallyCount, speedMultiplier: ball.speedMultiplier });
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// 60 FPS Fizik Döngüsü
setInterval(() => {
  // 1. Oyuncuların Fiziği
  for (const id in players) {
    const p = players[id];
    if (p.type === 'spectator') continue;

    p.vy += GRAVITY;
    p.x += p.vx;
    p.y += p.vy;

    if (p.x < p.minX) p.x = p.minX;
    if (p.x > p.maxX) p.x = p.maxX;

    if (p.y + p.height >= GROUND_Y) {
      p.y = GROUND_Y - p.height;
      p.vy = 0;
      p.isGrounded = true;
    }

    if (p.isSwinging) {
      p.swingTimer++;
      if (p.swingTimer > 12) {
        p.isSwinging = false;
        p.swingTimer = 0;
      }
    }
  }

  // 2. Topun Fiziği
  if (ball.inPlay) {
    ball.vy += 0.35;
    ball.x += ball.vx * ball.speedMultiplier;
    ball.y += ball.vy;

    // Tavan
    if (ball.y - ball.radius <= 0) {
      ball.y = ball.radius;
      ball.vy = Math.abs(ball.vy);
    }

    // Zemin
    if (ball.y + ball.radius >= GROUND_Y) {
      ball.y = GROUND_Y - ball.radius;
      ball.vy = -Math.abs(ball.vy) * 0.84;
    }

    // Duvarlar ve Kaleler
    const inGoalZone = ball.y >= GOAL_TOP && ball.y <= GOAL_BOTTOM;
    if (!inGoalZone) {
      if (ball.x - ball.radius <= 0) {
        ball.x = ball.radius;
        ball.vx = Math.abs(ball.vx) * 0.9;
        io.emit('wallBounce', { x: ball.x, y: ball.y });
      }
      if (ball.x + ball.radius >= CANVAS_WIDTH) {
        ball.x = CANVAS_WIDTH - ball.radius;
        ball.vx = -Math.abs(ball.vx) * 0.9;
        io.emit('wallBounce', { x: ball.x, y: ball.y });
      }
    } else {
      // Gol
      if (ball.x - ball.radius < -15) {
        p2Score++;
        io.emit('goalScored', { winner: 'samurai' });
        resetBall(1);
      } else if (ball.x + ball.radius > CANVAS_WIDTH + 15) {
        p1Score++;
        io.emit('goalScored', { winner: 'thief' });
        resetBall(-1);
      }
    }
  }

  // Durumu tüm istemcilere fırlat
  io.emit('gameState', { players, ball });
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Silkroad Arena sunucusu http://localhost:${PORT} portunda calisiyor!`);
});