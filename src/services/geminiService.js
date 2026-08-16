const MODEL = 'gemini-3.6-flash';

// @google/genai is ESM-only; load it lazily via dynamic import from this
// CommonJS file, and cache the client so we only initialize it once.
let aiClientPromise = null;
function getClient() {
  if (!aiClientPromise) {
    aiClientPromise = import('@google/genai').then(
      ({ GoogleGenAI }) => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    );
  }
  return aiClientPromise;
}

async function classifyMessage({ message, isOwner }) {
  const prompt = `
You are an AI operations agent for a small business in Nigeria. You receive WhatsApp messages either from the BUSINESS OWNER or from a CUSTOMER of that business. Owners may write in English, Nigerian Pidgin, or a mix of both (e.g. "I don sell 5k rice" or "Wetin be my report"). Understand Pidgin naturally.

Message sender: ${isOwner ? 'OWNER' : 'CUSTOMER'}
Message: "${message}"

Decide the intent and respond with ONLY valid JSON (no markdown, no backticks), matching this shape:

If sender is OWNER, one of:
{"intent": "log_sale", "amount": number, "description": string, "itemName": string or null, "quantity": number or null, "unit": string or null}
{"intent": "log_expense", "amount": number, "description": string}
{"intent": "log_credit", "customerName": string, "amount": number, "description": string}
{"intent": "log_credit_payment", "customerName": string, "amount": number}
{"intent": "ask_credits"}
{"intent": "log_restock", "item": string, "quantity": number, "unit": string or null}
{"intent": "ask_stock"}
{"intent": "ask_audit"}
{"intent": "log_payable", "payeeName": string, "amount": number, "reason": string, "accountNumber": string or null, "bankName": string or null}
{"intent": "confirm_payment", "payeeName": string}
{"intent": "ask_payables"}
{"intent": "ask_report", "period": "week"}
{"intent": "ask_business_question", "question": string}
{"intent": "ask_tax_estimate"}
{"intent": "unclear", "note": string}

Guidance:
- Use log_sale for a sale. Only fill itemName/quantity/unit when the owner clearly mentions a specific quantity of a physical item (e.g. "Sold 3 bags of rice for 15k" gives itemName "rice", quantity 3, unit "bags"). If they just say an amount with no clear quantity (e.g. "Sold 5k of rice"), leave itemName, quantity, and unit as null.
- Use log_credit when the owner gives goods or services to a named customer without full payment now.
- Use log_credit_payment when a named customer pays back money they owed.
- Use ask_credits when the owner asks who owes them money.
- Use log_restock when the owner adds new stock, e.g. "Restocked 20 bags of rice" or "Bought 50 pieces of soap".
- Use ask_stock when the owner asks about their current stock or inventory levels.
- Use ask_audit when the owner asks the agent to check, review, or audit their books/records, e.g. "check my books" or "audit my records".
- Use log_payable when the owner mentions needing to pay a specific supplier or person, e.g. "I need to pay Chidi's Supplies 15k for rice restock". Capture bank account number and bank name only if explicitly given in the message.
- Use confirm_payment when the owner confirms they want a previously mentioned payment sent now, e.g. "pay Chidi's Supplies" or "send it to Chidi's Supplies now".
- Use ask_payables when the owner asks who they need to pay or what bills are outstanding.
- Use ask_business_question for open-ended questions about how the business is doing, trends, comparisons, or advice, e.g. "how am I doing compared to last month" or "what should I focus on this week". Put their full question in the question field.
- Use ask_tax_estimate when the owner asks about tax, how much they might owe, or mentions the presumptive tax, e.g. "how much tax will I pay" or "wetin be my tax".

Amounts should be extracted as plain numbers in Naira (strip currency symbols, "k" means thousand, e.g. "5k" = 5000).

If sender is CUSTOMER, one of:
{"intent": "inquiry", "topic": string}
{"intent": "other", "note": string}
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt
  });
  const raw = response.text.trim().replace(/^```json\s*|\s*```$/g, '');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { intent: 'unclear', note: 'Could not parse agent response' };
  }
}

async function transcribeVoiceNote({ base64Audio, mimeType }) {
  const prompt = 'Transcribe this voice note exactly as spoken. The speaker may use English or Nigerian Pidgin. Respond with ONLY the transcribed text, nothing else.';

  const ai = await getClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { text: prompt },
      { inlineData: { mimeType, data: base64Audio } }
    ]
  });
  return response.text.trim();
}

async function parseReceiptImage({ base64Image, mimeType }) {
  const prompt = `
Extract the total amount and a short description from this receipt image.
Respond with ONLY valid JSON: {"amount": number, "description": string}
If you cannot read an amount, respond {"amount": null, "description": "unreadable"}.
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { text: prompt },
      { inlineData: { mimeType, data: base64Image } }
    ]
  });
  const raw = response.text.trim().replace(/^```json\s*|\s*```$/g, '');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { amount: null, description: 'unreadable' };
  }
}

async function generateCustomerReply({ businessName, businessType, topic, customerMessage }) {
  const prompt = `
You are the AI assistant for "${businessName}", a ${businessType} in Nigeria. A customer sent this message: "${customerMessage}"

Their inquiry topic: ${topic}

Write a short, warm, professional WhatsApp reply (2-3 sentences max) as the business. If you don't have specific info (like exact prices or hours), give a helpful general response and invite them to ask more or visit. Do not make up specific prices, addresses, or hours you don't know.
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  return response.text.trim();
}

async function generateWeeklySummary({ businessName, totalSales, totalExpenses, profit, bestDay, transactionCount }) {
  const prompt = `
Write a short, encouraging weekly business summary (3-4 sentences) for the owner of "${businessName}", in plain English, WhatsApp-message style.

Data:
- Total sales: ₦${totalSales}
- Total expenses: ₦${totalExpenses}
- Profit: ₦${profit}
- Best day: ${bestDay}
- Number of transactions logged: ${transactionCount}

Be direct with the numbers, mention the best day, and add one practical observation or tip if relevant (e.g. expenses trending high, or a strong week).
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  return response.text.trim();
}

async function analyzeTopItems({ sales }) {
  if (!sales.length) return [];

  const list = sales.map((s) => `- ${s.description || 'unknown'} (₦${s.amount})`).join('\n');
  const prompt = `
Here are this week's sales for a small Nigerian business, as freeform text descriptions:
${list}

Group these into the real underlying items being sold (the same item may appear with different wording, e.g. "rice" and "5 bags of rice" are the same item). Identify the top 3 items by number of times sold.

Respond with ONLY a valid JSON array, no markdown, no backticks, in this shape:
[{"item": string, "count": number, "totalAmount": number}]

If there is not enough information to group meaningfully, respond with an empty array: []
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  const raw = response.text.trim().replace(/^```json\s*|\s*```$/g, '');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * Answers an open-ended question about the business by reasoning over
 * real historical data, rather than reciting a single number. This is
 * the clearest example of the agent doing genuine analysis rather than
 * just logging and reporting.
 */
async function answerBusinessQuestion({ businessName, question, dataSummary }) {
  const prompt = `
You are the AI operations agent for "${businessName}", a small business in Nigeria. The owner asked you this question about their business:
"${question}"

Here is their real business data to answer from. Only use this data, never invent numbers that are not here:
${dataSummary}

Write a short, direct WhatsApp-style answer (3-5 sentences). Reference specific real numbers from the data. If the data is not enough to fully answer, say so honestly rather than guessing.
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  return response.text.trim();
}

/**
 * Reviews recent records for anything worth flagging, and writes a plain
 * English summary. The anomaly detection itself is done in code (see
 * dailyOpsService / api.js), this just turns the findings into a message.
 */
async function generateAuditSummary({ businessName, stats, flags }) {
  const flagsText = flags.length ? flags.map((f) => `- ${f}`).join('\n') : 'Nothing unusual found.';
  const prompt = `
You are auditing the recent records of "${businessName}", a small Nigerian business, as their AI operations agent. Write a short, plain English audit summary (4-6 sentences), WhatsApp-style.

Stats:
- Transactions reviewed: ${stats.transactionCount}
- Period: last ${stats.days} days
- Total sales: ₦${stats.totalSales}
- Total expenses: ₦${stats.totalExpenses}
- Average transaction size: ₦${stats.avgTransaction}

Flagged items:
${flagsText}

If nothing was flagged, reassure the owner their records look consistent. If something was flagged, explain it plainly without alarming them, and suggest what to double check.
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  return response.text.trim();
}

/**
 * Estimates the owner's likely position under Nigeria's 2026 presumptive
 * tax regime, based on their real logged turnover. This is deliberately
 * framed as an estimate to help them prepare, never as filed tax advice,
 * since getting this wrong has real consequences for the owner.
 */
async function generateTaxEstimate({ businessName, monthlyTurnover, annualizedTurnover }) {
  const prompt = `
You are explaining Nigeria's 2026 presumptive tax regime to the owner of "${businessName}", a small business, in plain WhatsApp-style English (4-6 sentences).

Facts to use, these are real and should not be changed:
- The presumptive tax regime introduced in 2026 applies a flat 1% tax on turnover for eligible informal businesses.
- Businesses with annual turnover of ₦12 million or below are exempt (the nano/small business exemption threshold).
- Separately, companies with annual turnover of ₦50 million or below pay 0% Companies Income Tax.

This business's numbers:
- Recorded turnover in the last 30 days: ₦${monthlyTurnover}
- Rough annualized estimate (last 30 days x 12): ₦${annualizedTurnover}

Explain simply where they likely fall based on this annualized estimate, and roughly what a 1% presumptive tax would come to if they are above the ₦12 million exemption. Be clear this is only a rough estimate from limited data, not a tax filing or professional advice, and that they should confirm their actual position with the Nigeria Revenue Service or a tax professional before paying anything.
`.trim();

  const ai = await getClient();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  return response.text.trim();
}

module.exports = {
  classifyMessage,
  transcribeVoiceNote,
  parseReceiptImage,
  generateCustomerReply,
  generateWeeklySummary,
  analyzeTopItems,
  answerBusinessQuestion,
  generateAuditSummary,
  generateTaxEstimate
};
