# BizAgent: AI Business Operations Agent for Nigerian SMEs

WhatsApp-based agent that does bookkeeping (text, voice note, or receipt photo), and sends weekly business health reports. Built for shops, salons, and restaurants that can't afford a bookkeeper.

Built for **Build with Gemini XPRIZE**, Small Business Services category.

## Features

- **Bookkeeping by text, voice, or photo.** Owners send a message, a voice note, or a receipt photo, and the agent logs it. Handles English and Nigerian Pidgin.
- **Customer credit tracking.** "Chidi owes 5k for rice" logs a debt, "Chidi paid 5k" logs a payment, "who owes me" lists outstanding balances.
- **Inventory tracking.** Mentioning a quantity in a sale ("Sold 3 bags of rice for 15k") or restocking ("Restocked 20 bags of rice") keeps stock levels current, with automatic low stock warnings.
- **Books audit on request.** "Check my books" has the agent review recent records for unusually large transactions or mismatched credit payments, and explain what it found in plain English.
- **Ask me anything.** Open-ended questions like "how am I doing compared to last month" get answered by the agent reasoning over real historical data, not a canned response.
- **Payment tracking with human confirmation.** The agent can prepare a payment to a supplier and only sends it (or hands over the details to send manually) after the owner explicitly confirms. Real transfers require a configured Paystack account; without one, the agent works in draft mode automatically.
- **Tax estimate helper.** Based on Nigeria's 2026 presumptive tax regime (a flat 1% turnover tax for informal businesses, with a ₦12 million annual exemption threshold), the agent gives the owner a rough estimate of where they likely fall, clearly framed as an estimate to confirm with a tax professional, not filed advice.
- **Weekly reports.** Every Sunday, a plain English profit summary lands in the owner's WhatsApp, including top sellers and outstanding credit.
- **Proactive daily checks.** Every evening, the agent decides on its own whether to nudge an inactive owner or flag unusually high spending.
- **Shareable customer link.** Each business gets a personal WhatsApp link. Customers who message through it get an AI reply as that business, without needing a separate WhatsApp number per shop.
- **Web dashboard.** A PIN-protected dashboard (`/dashboard.html`) shows real sales history, a 7-day chart, top sellers, outstanding credit, and a downloadable monthly PDF statement.
- **Landing page.** A marketing page (`/`) for pitching the product to shop owners.

## How it's AI-agent-operated (not just AI-assisted)
Every incoming message is classified and acted on by Gemini directly (`geminiService.classifyMessage`). The agent decides whether it's a sale, an expense, or a report request, and executes the database write itself. The daily checks service goes further: the agent decides, unprompted, when a business needs a nudge or a spending alert, and sends it without a human triggering that action.

## Setup (do this in order)

### 1. Gemini API key
- Go to https://aistudio.google.com/apikey
- Click "Create API key", copy it
- This satisfies the "must use a Google Cloud product" requirement

### 2. Supabase project
- Go to https://supabase.com, new project
- Once created: Project Settings, API Keys, copy Project URL and the service_role secret key (Legacy tab if using the new Supabase UI)
- Go to SQL Editor, paste the contents of schema.sql, Run
- If you already ran an older version of schema.sql before the PIN feature was added, just run: alter table businesses add column if not exists pin text;

### 3. Twilio WhatsApp Sandbox (free, instant)
- Sign up at https://console.twilio.com
- Go to Messaging, Try it out, Send a WhatsApp message
- You'll get a sandbox number (usually +14155238886) and a join code like "join xxx-xxx"
- From your own phone, WhatsApp that join code to the sandbox number
- Copy your Account SID and Auth Token from the console dashboard

### 4. Configure environment
```bash
cd bizagent
cp .env.example .env
# fill in GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
npm install
```

### 5. Run locally and expose to the internet
Twilio needs a public URL to send webhooks to.
```bash
npm run dev
# in a second terminal, using ngrok:
ngrok http 3000
```
Copy the https://xxxx.ngrok-free.dev (or similar) URL it gives you.

In Twilio Console, Messaging, Sandbox settings, "When a message comes in", paste:
https://xxxx.ngrok-free.dev/whatsapp/webhook

### 6. Test it
WhatsApp your sandbox number:
- First message asks you to register a business, reply: "Chidi's Salon, hair salon"
- You'll get a 4-digit dashboard PIN in the welcome message
- Try: "Sold 5k of rice", "Spent 2k on transport", "report"
- Try sending a voice note saying a sale out loud
- Try sending a photo of a receipt
- Open http://localhost:3000/dashboard.html, select the business, enter the PIN

### 7. Test the daily checks manually (without waiting until evening)
```bash
npm run cron:daily-checks
```

### 8. Try the new capabilities
- "Sold 3 bags of rice for 15k" then "check my stock" to see inventory tracking
- "Restocked 20 bags of rice"
- "I need to pay Chidi's Supplies 15k for rice restock" then "pay Chidi's Supplies" to see the payment flow in draft mode
- "check my books" for an audit
- "how am I doing compared to last month" to ask the agent a real question

### 9. Optional: enable real payments through Paystack
Without this, the payment feature works in draft mode: the agent prepares the payment and gives the owner the details to send manually. To let the agent send real transfers:
- Get a secret key from https://dashboard.paystack.com/#/settings/developer
- Add it to `.env` as `PAYSTACK_SECRET_KEY`
- Your Paystack account needs Transfers enabled and a funded balance, this is a real business requirement from Paystack, not something code alone can unlock

## Deploying for real (before you go sell this)
- The included routes and static files are ready to deploy as-is on Render, Railway, or any Node host
- Once deployed, replace the ngrok URL in Twilio with your permanent deployment URL
- For real customers, you'll eventually want actual WhatsApp Business API (not sandbox), but the sandbox is fine for demo and first paying customers this week

## Project structure
```
public/
  index.html             # Marketing landing page
  dashboard.html         # PIN-protected owner dashboard
src/
  server.js              # Express app, static files, cron scheduler
  routes/
    whatsapp.js           # Incoming message webhook (the agent's main loop)
    api.js                 # Dashboard data endpoints
  services/
    geminiService.js      # All AI decision-making, text and voice and image
    supabaseService.js    # Database reads and writes
    whatsappService.js    # Outbound WhatsApp sending
    weeklyReportService.js # Weekly report logic
    dailyOpsService.js    # Proactive nudges and spending alerts
    paystackService.js    # Optional real payment transfers
  utils/
    weeklyReportRunner.js # CLI: npm run cron:weekly-report
    dailyCheckRunner.js   # CLI: npm run cron:daily-checks
schema.sql               # Supabase table definitions
```

## Next steps to strengthen your submission
- [ ] Get 2-3 real shop or salon owners using it this week
- [ ] Add Paystack subscription billing for real revenue evidence
- [ ] Screenshot or export real WhatsApp conversations as customer evidence
- [ ] Record 3-min demo video showing the full flow, including the dashboard
- [ ] Write the 500-1000 word narrative on human vs AI division of labor
