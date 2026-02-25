import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', { reconnectionDelayMax: 10000 });

socket.on('connect', () => {
  console.log('connected', socket.id);
  socket.emit('createTournament', { name: 'Test Tournament from script', total_players: 256, creator: 'script' });
});

socket.on('tournamentCreated', (data) => {
  console.log('tournamentCreated:', data);
  process.exit(0);
});

socket.on('errorMessage', (msg) => {
  console.error('errorMessage from server:', msg);
  process.exit(1);
});

socket.on('connect_error', (err) => {
  console.error('connect_error', err.message);
  process.exit(2);
});

setTimeout(() => {
  console.error('timeout waiting for response');
  process.exit(3);
}, 8000);
