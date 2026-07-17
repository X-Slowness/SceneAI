# Personas — your own character chat website

This is a complete, working website where visitors pick a character and chat with them.
Everything runs on code you own:

- The **frontend** (`public/index.html`, `style.css`, `script.js`) is plain HTML/CSS/JS — no framework, no build step.
- The **backend** (`server.js`) is a small Node.js server that talks to Google's free Gemini API on your behalf, so your secret API key never sits in the browser where visitors could steal it.
- Characters and chat history are saved in each visitor's own browser (nothing is sent to any third party except the AI provider you choose).

No ad networks, no analytics trackers, no "free tier" website builder watermarking your pages. You control every line.

---

## 1. Get a free API key

This starter is wired for **Google's Gemini API** through Google AI Studio, which has a genuinely free tier — no credit card required, generous rate limits, good enough to run a personal chat site.

1. Go to https://aistudio.google.com/apikey
2. Sign in with any Google account.
3. Click **Create API key**.
4. Copy the key — you'll paste it in step 3 below.

The free tier has rate limits (currently around 15-60 requests per minute depending on the model), which is plenty for a personal project with normal traffic. If you ever outgrow it, the same code works with paid providers too — you'd just swap the API call in `server.js`.

## 2. Install Node.js

If you don't have it yet, download the LTS version from https://nodejs.org and install it (just click through the installer).

## 3. Set up the project on your computer

Open a terminal in this folder and run:

```bash
npm install
```

Then create your real environment file:

```bash
cp .env.example .env
```

Open `.env` in any text editor and replace `your-free-api-key-here` with the key you copied in step 1.

## 4. Run it locally

```bash
npm start
```

Open **http://localhost:3000** in your browser. You should see two starter characters — click one and start chatting. Use "+ New character" to create your own.

---

## 5. Put it on the internet, for free, with no ads

Since this needs a server (not just static files), the simplest free options are **Render** or **Railway** — both have a free tier for small Node.js apps and never insert ads or watermarks into your site.

### Deploying on Render (recommended for beginners)

1. Create a free account at https://render.com.
2. Push this project to a GitHub repository (Render deploys from GitHub). If you're not familiar with git yet, GitHub Desktop (https://desktop.github.com) makes this point-and-click.
3. In Render, click **New → Web Service** and connect your GitHub repo.
4. Set:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
5. Under **Environment**, add a variable: `GEMINI_API_KEY` = your key.
6. Deploy. Render gives you a free `https://yourapp.onrender.com` URL — that's your live website.

(Free-tier Render apps "sleep" after inactivity and take ~30 seconds to wake up on the next visit — fine for a personal project, upgrade later if that matters to you.)

### Custom domain (optional)

Once it's live, you can point a domain you own at it — Render's dashboard has a "Custom Domain" section with the exact records to add at your domain registrar.

---

## Keeping the free tier from getting maxed out

- `server.js` includes basic rate limiting (20 messages/minute per visitor) so no single visitor can eat your whole free quota.
- Google's free tier is generous but shared across your entire app, not per-visitor — if the site gets popular, you may hit the daily/per-minute cap. You'll see this as a 502 error in the browser and a rate-limit message logged on the server. At that point you can wait for the quota to reset, or move to a paid tier later — nothing else about the code needs to change.

## Customizing

- **Look and feel:** edit `public/style.css` — the color palette is defined at the top in `:root`.
- **Starter characters:** edit the `defaults` array near the top of `public/script.js`.
- **Response length:** change `max_tokens` in `server.js`.

You now own this end to end — no other company's tool sits between your visitors and your AI.
