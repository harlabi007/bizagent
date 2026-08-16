const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

async function sendMessage(toPhone, body) {
  // toPhone should be like "whatsapp:+2348012345678"
  return client.messages.create({
    from: FROM,
    to: toPhone,
    body
  });
}

module.exports = { sendMessage };
