# 🚀 Deploy to Render (Free Hosting)

Deploy your Quantum Ludo server to **Render.com** for FREE in 10 minutes!

---

## 📋 What You Get (Free Tier)

- ✅ **Always-on free tier** (never sleeps)
- ✅ **Public URL**: `https://your-project-xxxxx.onrender.com`
- ✅ **Auto-deploy** from GitHub
- ✅ **Environment variables** for secrets
- ✅ **Free SSL/HTTPS** (encrypted)
- ✅ **No credit card** required
- ✅ **Simple, beginner-friendly** interface

---

## 📝 Prerequisites

- [ ] GitHub account (free: https://github.com)
- [ ] Your code pushed to GitHub
- [ ] Render account (free: https://render.com)

---

## 🔧 Step 1: Push Code to GitHub

### Create a GitHub Repository

1. Go to https://github.com/new
2. Create repo: `quantum-ludo` (or any name)
3. Do NOT initialize with README

### Initialize Git Locally

```bash
cd "C:\xampp\htdocs\react backup"

# Initialize git
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit: Quantum Ludo"

# Add remote (replace USERNAME with your GitHub username)
git remote add origin https://github.com/USERNAME/quantum-ludo.git

# Rename branch to main and push
git branch -M main
git push -u origin main
```

Verify on GitHub: https://github.com/USERNAME/quantum-ludo

---

## 🎯 Step 2: Deploy on Render

### 1. Sign Up on Render
- Visit: https://render.com
- Click **Sign Up** → Use GitHub (easiest)
- Authenticate with GitHub

### 2. Create New Web Service
- Dashboard → Click **+ New** → **Web Service**
- Select your GitHub repository: `quantum-ludo`
- Click **Connect**

### 3. Configure Service

Fill in these details:

| Field | Value |
|-------|-------|
| **Name** | `quantum-ludo` |
| **Region** | Choose closest to you (US, EU, etc.) |
| **Branch** | `main` |
| **Root Directory** | `server` (where your index.js is) |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |

### 4. Environment Variables

Click **Add Environment Variable**:

```
NODE_ENV = production
PORT = 3001
JWT_SECRET = YourSecureRandomStringHereChangeThis
```

(Don't add Supabase/Twilio unless you're using them)

### 5. Deploy

- Click **Deploy**
- Wait 2-5 minutes for build/deployment
- You'll get a deployed URL like: `https://quantum-ludo-xxxxx.onrender.com`

---

## ✅ Verify Deployment

### Check if Server is Running

In browser, visit:
```
https://your-project-xxxxx.onrender.com
```

You should see a response (may be 404 or hello message).

### View Live Logs

- Render Dashboard → Your service → **Logs** tab
- See real-time server logs

---

## 📱 Step 3: Update APK for Public Server

### Update Client Environment Variable

Edit: `quantum-ludo/client/.env`

```
REACT_APP_API_URL=https://your-project-xxxxx.onrender.com
```

Replace `your-project-xxxxx` with your actual Render URL from Step 2.

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

New APK: `quantum-ludo\client\android\app\build\outputs\apk\release\app-release.apk`

---

## 🧪 Step 4: Test Server Connection

### From Phone App

1. Install new APK
2. **Login**
3. **Profile icon → ⚙️ Server Settings**
4. Enter: `https://your-project-xxxxx.onrender.com`
5. Tap **Save & Test**
6. Should show ✅ **Connected!**

### From Browser Console

Open DevTools (F12) and test:
```javascript
const socket = io('https://your-project-xxxxx.onrender.com');
socket.on('connect', () => console.log('✅ Connected!'));
socket.on('connect_error', (err) => console.log('❌', err.message));
```

---

## 🎮 Step 5: Distribute APK

Your app is now **publicly available**!

1. **Anyone** can download the APK
2. **Any device** connects to your public Render server
3. **Players from different networks** play together 🎯

Share the APK link and users can play!

---

## 💰 Cost (Free Forever)

| Item | Price |
|-------|-------|
| Hosting | Free |
| Bandwidth | Free |
| SSL/HTTPS | Free |
| **Total** | **Free** |

Render's free tier is truly unlimited (they make money from upgrades).

---

## 🔄 Deploy Updates

After code changes:

1. **Commit and push to GitHub:**
   ```bash
   git add .
   git commit -m "Updated features"
   git push
   ```

2. **Render auto-deploys** (1-2 minutes)

3. **Rebuild APK if client changed:**
   ```bash
   cd quantum-ludo\client
   npm run build
   npx cap copy
   cd android
   ./gradlew.bat assembleRelease
   ```

---

## 🚨 Troubleshooting

| Issue | Fix |
|-------|-----|
| Deploy fails | Check Render logs. Ensure `package.json` has `start` script in server folder. |
| "Cannot connect" | Verify URL is correct in `.env`. Check server logs in Render dashboard. |
| Server crashes | Check Render logs. Common: PORT env var missing. Render sets it automatically. |
| Slow first load | Render free tier spins down after 15 min idle. First request takes 30s. Normal. |

---

## 🔐 Security Tips

- [ ] Change `JWT_SECRET` to a strong random string
- [ ] Don't commit `.env` to GitHub (use `.env.example` template)
- [ ] Keep Render logs private
- [ ] Use HTTPS endpoints only (Render auto-provides)

---

## 📊 Monitoring

### View Logs
- Render Dashboard → Your service → **Logs**
- Real-time server output

### Check Status
- Green ✅ = Running
- Red ❌ = Error (check logs)

---

## 🎯 Your Next Steps

1. **Create GitHub repo** and push code
2. **Sign up on Render** (https://render.com)
3. **Connect GitHub repo** to Render
4. **Deploy** (2-5 min build)
5. **Get public URL**
6. **Update APK** with new server URL
7. **Build final APK**
8. **Share with testers** 🚀

---

## 📚 Resources

- Render Docs: https://render.com/docs
- GitHub Help: https://docs.github.com
- Node.js: https://nodejs.org/en/docs

**Your server will be live and public in 10 minutes! 🚀**
