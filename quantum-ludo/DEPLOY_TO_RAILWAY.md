# 🚀 Deploy to Railway (Free Hosting)

Deploy your Quantum Ludo server to **Railway.app** for FREE in 10 minutes!

---

## 📋 What You Get (Free Tier)

- ✅ **Always-on server** (500 hours/month = 24/7 coverage)
- ✅ **Public URL**: `https://your-project-xxxxx.railway.app`
- ✅ **Environment variables** for secrets
- ✅ **Auto-deploy** from GitHub
- ✅ **No credit card** required initially
- ✅ **$5/month free credit** (covers most small projects)

---

## 📝 Prerequisites

- [ ] GitHub account (free: https://github.com)
- [ ] Your code pushed to GitHub
- [ ] Railway account (free: https://railway.app)

---

## 🔧 Step 1: Push Code to GitHub

### Create a GitHub Repository

1. Go to https://github.com/new
2. Create repo: `quantum-ludo` (or any name)
3. Do NOT initialize with README (we'll push existing code)

### Initialize Git Locally (If Not Already Done)

```bash
cd "C:\xampp\htdocs\react backup"

# Initialize git
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit: Quantum Ludo with server and client"

# Add remote (replace USERNAME with your GitHub username)
git remote add origin https://github.com/USERNAME/quantum-ludo.git

# Rename branch to main and push
git branch -M main
git push -u origin main
```

After pushing, verify on GitHub: https://github.com/USERNAME/quantum-ludo

---

## 🚂 Step 2: Deploy on Railway

### 1. Go to Railway Dashboard
- Visit: https://railway.app/dashboard
- Click **Create** → **Deploy from GitHub repo**

### 2. Select Your Repository
- Search for `quantum-ludo` (or your repo name)
- Click **Deploy** (it auto-detects your project structure)

### 3. Wait for Build
- Railway automatically:
  - Detects Node.js server
  - Installs dependencies
  - Starts the server
  - Gives you a public URL

### 4. Get Your Public URL
- Click **Deployments** tab
- Copy the **URL** (looks like: `https://quantum-ludo-xxxxx.railway.app`)
- Test it in browser: `https://quantum-ludo-xxxxx.railway.app/health`

---

## 🔐 Step 3: Set Environment Variables (Optional but Recommended)

In Railway Dashboard:

1. Click **Variables** tab
2. Add:
   ```
   NODE_ENV=production
   PORT=3001
   JWT_SECRET=YourSecureRandomStringHere
   ```
3. Don't add `SUPABASE_*` unless you're using database (optional)

---

## 📱 Step 4: Update APK to Use Public Server

### Update Client Config

In your React client, update the default production server:

Edit `quantum-ludo/client/.env`:
```
REACT_APP_API_URL=https://your-project-xxxxx.railway.app
```

Replace `your-project-xxxxx` with your actual Railway URL.

### Rebuild APK

```bash
cd "quantum-ludo\client"

# Build web
npm run build

# Copy to Android
npx cap copy

# Build release APK
cd android
./gradlew.bat assembleRelease
```

New APK will be at:
```
quantum-ludo\client\android\app\build\outputs\apk\release\app-release.apk
```

---

## 🧪 Step 5: Test Connection

### Option A: In Mobile App

1. Install new APK on phone
2. **Profile → ⚙️ Server Settings**
3. Enter: `https://your-project-xxxxx.railway.app`
4. Tap **Save & Test**
5. Should show ✅ connection

### Option B: From Browser

Test server health:
```
https://your-project-xxxxx.railway.app/health
```
(May return 404, but if server responds = working ✅)

### Option C: Test Socket Connection

Open browser console (F12) and test:
```javascript
// In Chrome DevTools console:
const socket = io('https://your-project-xxxxx.railway.app');
socket.on('connect', () => console.log('✅ Connected!'));
socket.on('connect_error', (err) => console.log('❌', err));
```

---

## 🎮 Step 6: Play Publicly

Once deployed:

1. **Any user** can download your APK
2. **Automatically connects** to public server
3. **Players from different networks** can play together! 🎯

---

## 📊 Monitoring & Logs

### Watch Live Logs
- Railway Dashboard → **Deployments** → Click your deployment
- See real-time logs and errors

### Check Server Status
- Go to https://railway.app/dashboard
- Green ✅ = Running
- Red ❌ = Error (check logs)

---

## 💰 Cost Breakdown (Free Tier)

| Item | Price |
|------|-------|
| Base free tier | $0 |
| $5 free credit/month | $0 (first) |
| Bandwidth | Free |
| **Total** | **Free** |

After $5/month credit runs out: ~$7-15/month depending on usage (reasonable for small projects).

---

## 🚨 Troubleshooting

| Issue | Fix |
|-------|-----|
| Deployment fails | Check logs in Railway Dashboard. Ensure `package.json` has `start` script. |
| "Cannot connect" from app | Verify URL is correct. Check `NODE_ENV` is `production`. |
| Server crashes | Check Railway logs for errors. Common: missing env vars. |
| Port issues | Railway auto-assigns PORT. Ensure server uses `process.env.PORT`. |

---

## 🔄 Deploy Updates

After you update code:

1. **Commit and push to GitHub:**
   ```bash
   git add .
   git commit -m "Updated features"
   git push
   ```

2. **Railway auto-deploys** (within 1-2 minutes)

3. **Rebuild APK** if client changed:
   ```bash
   npm run build && npx cap copy && cd android && ./gradlew.bat assembleRelease
   ```

---

## 🎯 Next Steps

1. **Create GitHub account** (if needed)
2. **Push your code** to GitHub
3. **Deploy on Railway** (click deploy)
4. **Get public URL** from Railway
5. **Update APK** with new server URL
6. **Rebuild APK** and test

---

## 📚 Resources

- Railway Docs: https://railway.app/docs
- GitHub Help: https://docs.github.com
- Node.js Best Practices: https://nodejs.org/en/docs/

**Your server will be live and public in 10 minutes! 🚀**
