import { io } from 'socket.io-client';

if (process.argv.length < 3) {
  console.error('Usage: node test_start_tournament.js <tournamentId>');
  process.exit(2);
}
const tournamentId = process.argv[2];

const socket = io('http://localhost:3001', { reconnectionDelayMax: 10000 });

socket.on('connect', () => {
  console.log('connected', socket.id);
  socket.emit('startTournament', { tournamentId });
});

socket.on('tournamentStarted', (data) => {
  console.log('tournamentStarted:', data);
  process.exit(0);
});

socket.on('matchScheduled', (data) => {
  console.log('matchScheduled:', data);
});

socket.on('errorMessage', (msg) => {
  console.error('errorMessage from server:', msg);
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout waiting for response');
  process.exit(3);
}, 12000);
