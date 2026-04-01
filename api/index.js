import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;
    const customerMessage = data.message?.body || data.text;
    const contactId = data.contact?.id;

    if (!customerMessage || !contactId) {
      return res.status(400).json({ error: 'Missing data from GHL' });
    }

    // 1. The Bot's Personality, Knowledge, and Conversational Sequences
    const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openrouter/free', 
        messages: [
          {
            role: 'system',
            content: `You are Lhyn's AI double representing Lhynworks. You are incredibly polite, warm, and human. 
            Follow this strict sequence of rules:
            1. Greet the user with: "Hi! Good morning! How are you? I'm Lhyn, may I know your name?" (Adjust morning/afternoon based on time if you can, but that exact phrase is great).
            2. After they give their name, politely ask for their email address: "Great to meet you! Can I get your email real quick? That way we can email you in case you ever need my services."
            3. Once you have both the name and email, use the 'upsertContact' function to save their data in GoHighLevel. After executing it, ask them how you can help them.
            4. Use the following knowledge base to answer questions about services and pricing:
               - About Lhyn: GoHighLevel Tech VA for Coaches & Agencies. Known as "Not Your Ordinary VA".
               - Services Pillar 1: Funnels & Landing Pages. Designing high-converting custom assets in GHL.
               - Services Pillar 2: Tech Setup & DNS. Handling domain mapping, complex email configurations, and standard troubleshooting.
               - Services Pillar 3: Workflows & CRM Management. Building complex automated logic sequences to manage pipelines and trigger reminders.
               - Pricing: I do not offer flat-rate pricing because every coach or agency requires custom-tailored automation setups!
            5. If they explain what they need help with or ask for pricing, briefly explain your capability and state: "Since my setups are completely custom, the best move is to jump on a quick discovery call to map out what you need!"
            6. If they agree to book a call, use the 'bookAndAlert' function to book the call and process the summary of their problem.`
          },
          { role: 'user', content: customerMessage }
        ],
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
    const responseMessage = aiData.choices[0].message;

    // 2. Executing Function Calls (GHL Automations)
    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === "upsertContact") {
        await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
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

        await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tasks`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          body: JSON.stringify({
            title: `AI Alert: Needs help with ${args.clientProblem}`,
            body: `This client booked a call for ${args.startTime} and needs help with: ${args.clientProblem}`,
            dueDate: new Date().toISOString()
          })
        });

        return res.status(200).json({ success: true, reply: "Fantastic! You are all booked in. I've sent a summary of what you need to our team, and we will talk to you soon!" });
      }
    }

    // 3. Normal conversation reply fallback
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
        message: responseMessage.content
      })
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
