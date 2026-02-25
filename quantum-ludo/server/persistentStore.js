import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const filePath = path.join(dataDir, 'tournaments.json');

function ensureDataDir() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    console.warn('persistentStore.ensureDataDir failed:', e && e.message);
  }
}

export function loadTournaments() {
  try {
    ensureDataDir();
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({}, null, 2), 'utf8');
      return {};
    }
    const raw = fs.readFileSync(filePath, 'utf8') || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.warn('persistentStore.loadTournaments failed:', e && e.message);
    return {};
  }
}

export function saveTournaments(obj) {
  try {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(obj || {}, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('persistentStore.saveTournaments failed:', e && e.message);
    return false;
  }
}
