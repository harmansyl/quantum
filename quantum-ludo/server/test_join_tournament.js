import { io } from 'socket.io-client';

if (process.argv.length < 3) {
  console.error('Usage: node test_join_tournament.js <tournamentId>');
  process.exit(2);
}
const tournamentId = process.argv[2];
const playerName = process.argv[3] || 'testPlayer';

const socket = io('http://localhost:3001', { reconnectionDelayMax: 10000 });

socket.on('connect', () => {
  console.log('connected', socket.id);
  socket.emit('joinTournament', { tournamentId, playerName });
});

socket.on('joinedTournament', (data) => {
  console.log('joinedTournament:', data);
  process.exit(0);
});

socket.on('tournamentUpdate', (data) => {
  console.log('tournamentUpdate:', data);
});

socket.on('errorMessage', (msg) => {
  console.error('errorMessage from server:', msg);
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout waiting for response');
  process.exit(3);
}, 8000);
