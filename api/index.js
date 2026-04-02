import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;
    console.log("📥 Incoming webhook payload:", JSON.stringify(data));
    
    const customerMessage = data.customData?.message || data.message?.body || data.message || "Hello";
    const contactId = data.customData?.id || data.contact_id || data.id;

    if (!contactId) {
      console.log("⚠️ Stopping: Missing contact ID.");
      return res.status(400).json({ error: 'Missing contact id from GHL' });
    }

    const formattedHistory = [];
    const previousBotReply = data.customData?.last_bot_reply;
    const previousUserMsg = data.customData?.last_user_message;

    if (previousBotReply && previousUserMsg) {
      formattedHistory.push({ role: 'user', parts: [{ text: previousUserMsg }] });
      formattedHistory.push({ role: 'model', parts: [{ text: previousBotReply }] });
    }

    formattedHistory.push({ role: 'user', parts: [{ text: customerMessage }] });

    const systemInstruction = `You are Lhyn's AI double representing Lhynworks. You are incredibly polite, warm, and human. 
    Follow this strict sequence of rules:
    1. If this is the start of the conversation, greet the user with: "Hi! Good morning! How are you? I'm Lhyn, may I know your name?"
    2. After they give their name, politely ask for their email address: "Great to meet you! Can I get your email real quick? That way we can email you in case you ever need my services."
    3. Use the following knowledge base to answer questions about services and pricing:
       - About Lhyn: GoHighLevel Tech VA for Coaches & Agencies.
       - Services: Funnels & Landing Pages, Tech Setup & DNS, Workflows & CRM Management.
       - Pricing: Custom services generally start at around $250 for smaller setups and up to $1,000+ for full account overhauls. Give ballpark estimates and suggest a call.
    4. If they agree to book a call, use the 'bookAndAlert' function to book the call. If they just want to do it themselves, provide your GHL calendar link directly in the chat: "https://lhynworks.com/calendar"
    5. If they say "Thank you", politely say "You're welcome!", summarize, and say goodbye.
    6. CRITICAL: If the user provides their name at any point in the conversation, use the 'updateContactName' tool immediately to save it!`;

    console.log("🛰️ Sending request directly to Google Gemini...");
    
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: formattedHistory,
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        tools: [{
          functionDeclarations: [
            {
              name: "bookAndAlert",
              description: "Books the client on the calendar for an overview call.",
              parameters: {
                type: "OBJECT",
                properties: {
                  clientProblem: { type: "STRING", description: "A quick summary of what the client needs help with." },
                  startTime: { type: "STRING", description: "ISO 8601 format date time for the appointment." }
                },
                required: ["clientProblem", "startTime"]
              }
            },
            {
              name: "updateContactName",
              description: "Updates the customer's first name in GoHighLevel.",
              parameters: {
                type: "OBJECT",
                properties: {
                  firstName: { type: "STRING", description: "The customer's actual first name extracted from message." }
                },
                required: ["firstName"]
              }
            }
          ]
        }]
      })
    });

    const aiData = await geminiResponse.json();
    console.log("📥 Gemini response received.");
    
    if (aiData.error) throw new Error(`Gemini API Error: ${aiData.error.message}`);
    
    const responseMessage = aiData.candidates?.[0]?.content;
    const functionCall = responseMessage?.parts?.find(part => part.functionCall);

    // Handle AI function calls
    if (functionCall) {
      const args = functionCall.functionCall.args;
      const functionName = functionCall.functionCall.name;

      if (functionName === "bookAndAlert") {
        console.log(`📞 AI is booking a call...`);
        await fetch('https://services.leadconnectorhq.com/calendars/appointments', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          body: JSON.stringify({
            calendarId: process.env.GHL_CALENDAR_ID,
            contactId: contactId,
            startTime: args.startTime,
            title: `AI Chat - ${args.clientProblem}`
          })
        });

        await fetch('https://services.leadconnectorhq.com/conversations/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-04-15'
          },
          body: JSON.stringify({
            type: 'Live_Chat',
            contactId: contactId,
            message: "Fantastic! You are all booked in. We will talk to you soon!"
          })
        });
        return res.status(200).json({ success: true });
      }

      if (functionName === "updateContactName") {
        console.log(`📝 AI is saving the contact's name as: ${args.firstName}`);
        try {
          await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            },
            body: JSON.stringify({
              firstName: args.firstName
            })
          });
          console.log("✅ Contact name updated successfully in GHL.");
        } catch (err) {
          console.log("⚠️ Failed to update name in GHL:", err.message);
        }
      }
    }
    
    const replyText = responseMessage?.parts?.[0]?.text || "Thanks for messaging! How can I help you today?";

    // Send the message back to GHL conversation
    console.log("📤 Sending message back to GHL conversation...");
    const ghlMessageResponse = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-04-15'
      },
      body: JSON.stringify({
        type: 'Live_Chat',
        contactId: contactId,
        message: replyText
      })
    });

    const ghlResponseData = await ghlMessageResponse.json();
    if (!ghlMessageResponse.ok) throw new Error(`GHL Message API failed: ${ghlResponseData.message || JSON.stringify(ghlResponseData)}`);

    console.log("🎉 Process completed successfully.");
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('🚨 Process stopped by error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
