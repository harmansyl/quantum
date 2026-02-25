# Match Reminder Implementation for OngoTournament

## Overview
Added automatic scheduled reminder functionality and manual reminder sending to the OngoTournament component to notify joined players that matches will start in 15 minutes.

## Changes Made

### 1. Frontend Changes (ongotournament.jsx)

#### Added State
- `reminderScheduled`: Tracks whether a reminder has been scheduled for the tournament

#### Added useEffect Hook (Line 20-50)
Automatically schedules a reminder 15 minutes before tournament start:
- Checks if tournament has a start time (`starts_at`, `start_time`, or `scheduled_at`)
- Calls the server's `/api/reminders/schedule/:id` endpoint with:
  - `minutesBefore: 15`
  - Custom message: "Reminder: [Tournament Name] match will start in 15 minutes. Please be ready!"
- Logs scheduling status to console

#### Added sendManualReminder Function (Line 285-318)
Allows admins to manually send reminders to all joined players:
- Validates tournament data exists
- Calls `/api/reminders/tournament/:id` endpoint
- Sends custom message to all players with phone numbers
- Shows success/error alert to user
- Logs response for debugging

#### Added UI Button
- Location: Round header (next to "Next Round" button)
- Label: "Send Reminder"
- Color: Green (#28a745)
- Click handler: Triggers `sendManualReminder()`
- Tooltip: "Send match reminder to all joined players"

### 2. Frontend Styling Changes (ongotournament.css)

Added CSS for reminder button:
```css
.btn.send-reminder { 
  background: #28a745;
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 8px;
  transition: background 120ms ease;
}

.btn.send-reminder:hover { background: #34d65e; }
.btn.send-reminder:active { background: #20752a; }
```

### 3. Server Integration

The implementation leverages existing server functionality in `whatsappReminders.js`:

#### Automatic Scheduling
- Endpoint: `POST /api/reminders/schedule/:id`
- Uses `scheduleTournamentReminder()` function
- Calculates delay = start_time - minutesBefore (15 minutes)
- Sets up Node.js setTimeout to send at the right time
- Sends WhatsApp messages to all tournament players

#### Manual Sending
- Endpoint: `POST /api/reminders/tournament/:id`
- Resolves all player phone numbers from Supabase or fallback store
- Sends WhatsApp message to all players
- Returns count of successfully sent reminders

## How It Works

### Automatic Reminder Flow
1. Tournament is loaded in OngoTournament component
2. useEffect detects tournament change
3. Fetches tournament start time from server
4. POSTs to `/api/reminders/schedule/{tournamentId}` with 15-minute buffer
5. Server calculates exact delay and sets up timer
6. At the calculated time, WhatsApp reminders sent to all players

### Manual Reminder Flow
1. Admin clicks "Send Reminder" button
2. Triggers `sendManualReminder()` function
3. POSTs to `/api/reminders/tournament/{tournamentId}`
4. Server resolves all player phone numbers
5. Sends WhatsApp messages immediately
6. User sees success/failure alert with count

## Requirements

### Server Side
- Twilio account configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM) OR
- WhatsApp Cloud API configured (WHATSAPP_CLOUD_TOKEN, WHATSAPP_PHONE_NUMBER_ID)
- Tournament records must have:
  - `starts_at`, `start_time`, or `scheduled_at` field (for automatic scheduling)
  - Valid start time (not null/invalid)

### Data
- Players must have phone numbers in one of these fields:
  - `phone`
  - `phone_number`
  - `player_phone`
  - `phoneNumber`
  - `player_phone_number`
  - Nested: `user.phone` or `contact.phone`

## Error Handling

### Automatic Scheduler
- Logs to console if no start time is set
- Catches and logs scheduling errors
- If start time already passed, sends immediately

### Manual Reminder
- Shows alert if tournament data unavailable
- Displays error message if send fails
- Shows success count of messages sent
- All errors logged to console

## Testing

### To Test Automatic Scheduling:
1. Create a tournament with a start time set
2. Open the tournament in OngoTournament
3. Check browser console for "Match reminder scheduled:" message
4. Server will send reminders 15 minutes before start time

### To Test Manual Reminder:
1. Ensure players are joined with valid phone numbers
2. Click "Send Reminder" button in any round
3. Watch for success alert with count of players notified
4. Verify WhatsApp messages received by players

## Files Modified
- [client/src/pages/ongoTournament/ongotournament.jsx](ongotournament.jsx) - Added reminder scheduling and manual sending
- [client/src/pages/ongoTournament/ongotournament.css](ongotournament.css) - Added styling for reminder button

## Dependencies
- Existing server endpoints: `/api/reminders/schedule/:id`, `/api/reminders/tournament/:id`
- WhatsApp reminders module already implemented in `server/whatsappReminders.js`
