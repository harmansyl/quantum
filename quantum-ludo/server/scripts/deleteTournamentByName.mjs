import supabase from '../supabaseClient.js';

async function run() {
  if (!supabase) {
    console.error('Supabase client not configured in env. Aborting.');
    process.exit(2);
  }

  const name = process.argv[2] || '256 TM - 1';
  console.log('Searching for tournament with name:', name);
  try {
    const { data, error } = await supabase.from('tournaments').select('*').ilike('name', name).limit(50);
    if (error) {
      console.error('Supabase select error:', error.message || error);
      process.exit(1);
    }
    if (!data || data.length === 0) {
      console.log('No tournaments found with that name.');
      process.exit(0);
    }
    console.log(`Found ${data.length} matching tournament(s):`);
    for (const t of data) {
      console.log(JSON.stringify(t, null, 2));
    }

    const id = data[0].id;
    console.log('Attempting to delete tournament id:', id);

    // delete dependent rows first
    try {
      await supabase.from('tournament_players').delete().eq('tournament_id', id);
      await supabase.from('tournament_matches').delete().eq('tournament_id', id);
    } catch (e) {
      console.warn('Warning: deleting dependent rows failed (continuing):', e && e.message);
    }

    const { data: delData, error: delErr } = await supabase.from('tournaments').delete().eq('id', id).select().single();
    if (delErr) {
      console.error('Delete error:', delErr.message || delErr);
      process.exit(1);
    }
    console.log('Deleted tournament:', JSON.stringify(delData, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('Unexpected error:', e && e.message);
    process.exit(1);
  }
}

run();
