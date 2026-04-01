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

    // 1. Fetch the last 10 messages from GHL so the bot has memory!
    let formattedHistory = [];
    try {
      console.log("📜 Fetching conversation history from GHL...");
      const historyResponse = await fetch(`https://services.leadconnectorhq.com/conversations/messages?contactId=${contactId}&limit=10`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Version': '2021-04-15'
        }
      });
      const historyData = await historyResponse.json();
      
      if (historyData.messages) {
        formattedHistory = historyData.messages.reverse().map(msg => ({
          role: msg.direction === 'inbound' ? 'user' : 'assistant',
          content: msg.body
        }));
      }
    } catch (e) {
      console.log("⚠️ Could not retrieve history, proceeding without it:", e.message);
    }

    // Build OpenRouter messages array
    const systemMessage = {
      role: 'system',
      content: `You are Lhyn's AI double representing Lhynworks. You are incredibly polite, warm, and human. 
      Follow this strict sequence of rules:
      1. Greet the user with: "Hi! Good morning! How are you? I'm Lhyn, may I know your name?"
      2. After they give their name, politely ask for their email address: "Great to meet you! Can I get your email real quick? That way we can email you in case you ever need my services."
      3. Once you have both the name and email, use the 'upsertContact' function to save their data in GoHighLevel. After executing it, ask them how you can help them.
      4. Use the following knowledge base to answer questions about services and pricing:
         - About Lhyn: GoHighLevel Tech VA for Coaches & Agencies.
         - Services: Funnels & Landing Pages, Tech Setup & DNS, Workflows & CRM Management.
         - Pricing: Custom services generally start at around $250 for smaller setups and up to $1,000+ for full account overhauls. Give ballpark estimates and suggest a call.
      5. If they agree to book a call, use the 'bookAndAlert' function to book the call.
      6. If they say "Thank you", politely say "You're welcome!", summarize, and say goodbye.`
    };

    const openRouterMessages = [systemMessage, ...formattedHistory];
    
    if (formattedHistory.length === 0) {
      openRouterMessages.push({ role: 'user', content: customerMessage });
    }

    // 2. Requesting OpenRouter
    console.log("🛰️ Sending request to OpenRouter using Gemini Flash...");
    const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://lhynworks.com', 
        'X-Title': 'Lhynworks AI Receptionist'
      },
      body: JSON.stringify({
        // Gemini handles tools better on the free tier than Gemma
        model: 'google/gemini-2.5-flash:free', 
        messages: openRouterMessages,
        tools: [
          {
            type: "function",
            function: {
              name: "upsertContact",
              description: "Saves the guest's name and email in GHL.",
              parameters: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  email: { type: "string" }
                },
                required: ["email", "firstName"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "bookAndAlert",
              description: "Saves their specific problem and books them on the calendar.",
              parameters: {
                type: "object",
                properties: {
                  clientProblem: { type: "string", description: "A quick summary of what the client needs help with." },
                  startTime: { type: "string", description: "ISO 8601 format date time for the appointment." }
                },
                required: ["clientProblem", "startTime"]
              }
            }
          }
        ]
      })
    });

    const aiData = await openRouterResponse.json();
    console.log("📥 OpenRouter raw response received.");
    
    if (aiData.error) throw new Error(`OpenRouter Error: ${aiData.error.message}`);
    
    const responseMessage = aiData.choices[0].message;

    // 3. Executing Function Calls (GHL Automations)
    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === "upsertContact") {
        await fetch('https://services.leadconnectorhq.com/contacts/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          body: JSON.stringify({
            locationId: process.env.GHL_LOCATION_ID,
            firstName: args.firstName,
            email: args.email
          })
        });

        return res.status(200).json({ success: true, reply: `Perfect, I've got you in the system, ${args.firstName}! How can I help you today?` });
      }

      if (toolCall.function.name === "bookAndAlert") {
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

        return res.status(200).json({ success: true, reply: "Fantastic! You are all booked in. We will talk to you soon!" });
      }
    }

    const replyText = responseMessage.content || "Thanks for messaging! How can I help you today?";

    // 4. Normal conversation reply
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
    console.log("📥 GHL message response received:", JSON.stringify(ghlResponseData));

    if (!ghlMessageResponse.ok) {
      throw new Error(`GHL Message API failed: ${ghlResponseData.message || JSON.stringify(ghlResponseData)}`);
    }

    console.log("🎉 Process completed successfully.");
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('🚨 Process stopped by error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
