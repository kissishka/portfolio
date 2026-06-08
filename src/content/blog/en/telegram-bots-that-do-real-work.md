---
title: "Telegram bots that do real work"
description: "Most bots are toys. The useful ones share a shape — a clear trigger, an idempotent action, and a boring deployment. Here's the skeleton I reach for."
pubDate: 2026-06-04
tags: ["bots", "automation"]
---

A bot earns its keep when it removes a recurring manual step — not when it
replies with a clever message. The useful ones I've built all share the same
small shape.

## A webhook, not a poll

Long-polling is fine for a prototype, but a webhook is cheaper and lets the bot
live on the same edge as everything else. Telegram POSTs each update; you
validate it and act:

```ts
export async function onUpdate(update: Update) {
  const message = update.message;
  if (!message?.text) return;

  if (message.text.startsWith("/deploy")) {
    await enqueueDeploy(message.chat.id);
    await reply(message.chat.id, "Deploy queued ✅");
  }
}
```

## Make every action idempotent

Telegram will retry a webhook it thinks failed, so the same update can arrive
twice. Key each side effect on the update's ID and you can safely process it
again with no double deploys, no duplicate messages.

## Keep secrets out of the code

The bot token and any API keys live in the platform's secret store, injected as
environment variables at runtime — never in the repo. The CSP and headers
discipline from the rest of the site applies here too: least privilege, by
default.

A bot like this is a few hundred lines, deploys like any other worker, and
quietly does its one job for months. That's the bar: boring, reliable, and out
of your way.
