-- Supabase SQL schema for tournaments

-- tournaments table
create table if not exists tournaments (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  total_players int not null default 256,
  creator text,
  status text not null default 'waiting', -- waiting, in_progress, finished
  created_at timestamptz default now()
);

-- tournament players
create table if not exists tournament_players (
  id uuid default gen_random_uuid() primary key,
  tournament_id uuid references tournaments(id) on delete cascade,
  player_id text not null,
  player_name text,
  joined_at timestamptz default now(),
  finish_position int
);

-- matches
create table if not exists tournament_matches (
  id uuid default gen_random_uuid() primary key,
  tournament_id uuid references tournaments(id) on delete cascade,
  round_number int not null,
  match_index int not null,
  room_code text,
  players jsonb,
  result jsonb,
  status text default 'scheduled', -- scheduled, playing, finished
  created_at timestamptz default now()
);
