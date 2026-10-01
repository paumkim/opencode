---
name: plain-prose
description: House style for all documentation, READMEs, comments, commit messages and long-form replies. Removes the default rhetorical furniture (em-dash asides, "not just X but Y", telegraph colons, rule-of-three padding, bolded lead-ins, throat-clearing openers) in favour of short declarative sentences and concrete specifics. Use before writing or reviewing any prose longer than a few lines, and before committing a README or doc change.
---

# Plain prose

Technical writing should read like an engineer explaining something to another
engineer. Short sentences. Concrete nouns. Numbers where numbers exist. No
rhetorical furniture.

The problem this skill solves: the default output style leans on em-dash
asides, false antithesis, and emphatic framing. That style is recognisable,
which means it carries no information. A reader can tell a machine wrote the
sentence before reading the sentence.

## The register to aim for

Reference points: Brian Kernighan's writing, John Carmack's blog posts, the
Linux kernel documentation, actual RFCs. Not a style guide. Just people who
knew what they meant.

- Short sentences. Under 25 words. Break anything longer.
- Concrete over abstract. "drops 49 packets an hour", not "provides granular
  visibility".
- State the thing. No build-up.
- Numbers instead of adjectives.
- Admit limitations flatly.
- Keep the technical vocabulary. "Masquerade", "SOCKS5 greeting", "conntrack"
  are correct. Do not translate them into "network hiding trick".

## Files

None. The tables and the audit script this skill used to ship with are not in
this directory. The catalogue of tells is the list below, and an audit is a
grep for the mechanical ones:

```
rg -n '—|not just|here.s the thing|worth noting' README.md
```

## Tells to remove, with replacements

### 1. Em-dash as an aside

The single loudest tell. An em-dash inside a sentence signals "here is
something I felt like adding."

```
Bad:  A residential proxy pays for your connection — strangers' traffic
      leaves over your uplink — and you get a few dollars a month.
Good: A residential proxy pays for your connection. Strangers' traffic
      leaves over your uplink. You get a few dollars a month.
```

Most asides are not load-bearing. Delete it first. If it turns out to matter,
make it its own sentence.

Target: zero em-dashes in a README. One in a long document is fine if it
genuinely cannot be split.

### 2. False antithesis

"It's not just X, it's Y" and "This isn't X, it's Y" invent a position nobody
held in order to knock it down.

```
Bad:  This isn't just a firewall, it's a statement about what this machine is for.
Good: The firewall drops forwarded traffic. The machine cannot route.
```

A real comparison is fine. "A detector that cries wolf is worse than no
detector" is a real claim with a real reason. Keep those.

### 3. Telegraph colon

A colon at the end of a line, right before a reveal that needs no reveal.

```
Bad:  The mechanism is simple:
      it just closes the door.

Good: WARD closes the door. It drops inbound connections by default.
```

### 4. Meta-framing phrases

Delete the whole clause and answer directly.

- "Here's the thing" / "Here's why that matters" / "Here's where X comes in"
- "the honest answer is" / "the real question is" / "the short answer is"
- "worth being precise about" / "worth flagging" / "worth noting honestly"
- "it's important to understand that"

### 5. Throat-clearing openers

Never open with these.

- "Great question!" / "Absolutely!" / "I'd be happy to"
- "So, to answer your question:"
- "Let me check that for you, I'll get back to you"

### 6. Bolded lead-ins on every list item

Bold is for literal identifiers: a flag, a path, a key, a config name.

```
Bad:  - **Detection.** Fourteen rules.
      - **Proof.** Packet capture.
      - **Containment.** Forensics first.

Good: - Detection: fourteen rules, `ward explain R05`
      - Proof: packet capture, `ward analyze-pcap`
      - Containment: forensics before any action
```

### 7. Padding to three

If there are two things, write two. If there are five, write five. Do not add a
third for rhythm. "detects, proves, and prevents" is only honest if those are
the three real capabilities.

### 8. Empty intensifiers

"very", "really", "extremely", "incredibly", "super", "quite", "fairly". Delete
them. If the claim needs the intensifier, the claim is too weak.

### 9. Restating the heading

If the heading is "Detection", do not open with "Detection is where WARD earns
its keep." The heading already said that.

### 10. Closing summary

Do not end by restating the section you just finished. Stop when the point is
made.

### 11. Hedged claims that should be flat

- "presents a risk" → "allows"
- "helps prevent" → "prevents" or "does not prevent"
- "can help with" → name the action

## Checklist before committing prose

Run this on any document or long reply.

1. Count em-dashes. Target zero.
2. Read the first sentence of each paragraph. If it exists only to introduce the
   next one, delete it.
3. Find every `**bold**`. Ask whether it is a literal identifier or an emphasis
   someone added. Delete the second kind.
4. Search for `not just`, `not only`, `Here's`, `worth `, `the real `,
   `important to note`. Delete the sentence containing each.
5. Find sentences over 25 words. Split them.
6. Find the paragraph that only exists to summarise the one before it. Delete
   it.
7. Read it aloud. Where you run out of breath, put a full stop.

## What not to do

Do not sand the writing down into blandness. Plain is not the goal. Clear is
the goal. Keep:

- Directness. "This is bad" beats "this presents certain challenges".
- Confident short declaratives.
- Real numbers, real paths, real command names.
- Admitting limits without hedging.
- Voice. Some people are funny. Dropping every personality trait produces
  corporate sludge, which has the same problem in reverse: it is
  unrecognisable because it says nothing.

## Different registers

- **Docs and READMEs**: this skill, strictly.
- **Code comments**: this skill, strictly. If a comment restates the code,
  delete it.
- **Commit messages**: this skill for the body. Keep conventional-commit
  subjects. State what changed and why, no summary of the diff.
- **Chat replies**: this skill for anything over three sentences.
- **Log output, error strings, CLI help**: keep them shorter still. No
  sentences at all where a phrase does the job.