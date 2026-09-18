/**
 * Candidate extraction pools from user messages.
 * Extracts structured candidates: text, spans, numbers, dates, places, people.
 */

import nlp from "compromise";
import { parse } from "chrono-node";

/**
 * A single extracted candidate with position info.
 */
export interface Candidate {
  value: string;
  start: number;
  end: number;
  source: string;
}

/**
 * Candidate extraction pools from a user message.
 */
export interface Pools {
  text: string;
  spans: string[];
  numbers: Candidate[];
  dates: Candidate[];
  places: Candidate[];
  people: Candidate[];
  recentResults: string[];
  message: string;
}

const DEFAULT_PLACES = [
  "United States", "USA", "United Kingdom", "UK", "Canada", "Australia", "Germany", "France", "Japan", "China",
  "India", "Brazil", "Mexico", "Italy", "Spain", "Netherlands", "Sweden", "Norway", "Finland", "Denmark",
  "Switzerland", "Austria", "Belgium", "Portugal", "Ireland", "New Zealand", "South Africa", "Egypt", "Morocco",
  "Argentina", "Chile", "Colombia", "Peru", "Venezuela", "Cuba", "Jamaica", "Thailand", "Vietnam", "South Korea",
  "North Korea", "Indonesia", "Philippines", "Malaysia", "Singapore", "Pakistan", "Bangladesh", "Saudi Arabia",
  "United Arab Emirates", "Israel", "Turkey", "Greece", "Poland", "Czech Republic", "Romania", "Hungary", "Ukraine",
  "Russia", "Washington", "California", "Texas", "Florida", "New York", "London", "Paris", "Berlin", "Tokyo",
  "Beijing", "Mumbai", "Sydney", "Melbourne", "Toronto", "Vancouver", "Dubai", "Moscow", "Rome", "Madrid",
  "Boston", "Chicago", "Seattle", "San Francisco", "Los Angeles", "Denver", "Atlanta", "Miami", "Dallas",
  "Houston", "Phoenix", "Philadelphia", "Detroit", "Minneapolis", "Portland", "Las Vegas", "San Diego",
  "Mount Everest", "Mount Fuji", "Mount Kilimanjaro", "Mount McKinley", "Mount Whitney", "Lake Tahoe",
  "Lake Michigan", "Lake Superior", "Lake Victoria", "Lake Baikal", "Lake Como", "Lake Garda",
  "Yellowstone County", "Cook County", "Los Angeles County", "Maricopa County", "San Diego County",
  "Orange County", "Kings County", "Queens County", "Middlesex County", "Essex County",
];

const NON_NAME_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "would", "could", "should",
  "there", "their", "what", "about", "which", "when", "where", "who", "whom", "whose",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december",
]);

/**
 * Build candidate extraction pools from a user message.
 */
export function buildPools(message: string, recentResults: string[] = []): Pools {
  const doc = nlp(message);
  const terms = doc.terms();
  const spans: string[] = [];
  const numbers: Candidate[] = [];
  const dates: Candidate[] = [];
  const places: Candidate[] = [];
  const people: Candidate[] = [];

  // Word spans (split on whitespace, keep punctuation attached)
  const words = message.split(/\s+/).filter((w) => w.length > 0);
  let cursor = 0;
  for (const word of words) {
    const start = message.indexOf(word, cursor);
    const end = start + word.length;
    spans.push(word);
    cursor = end;
  }

  // Numbers via compromise + regex for currency/percentages
  const numberMatches = message.matchAll(/(?:\$[\d,]+(?:\.\d{2})?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?)/g);
  for (const m of numberMatches) {
    numbers.push({
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      source: "regex",
    });
  }

  // Dates via chrono-node
  const parsedDates = parse(message);
  for (const d of parsedDates) {
    dates.push({
      value: d.text,
      start: d.index,
      end: d.index + d.text.length,
      source: "chrono",
    });
  }

  // Places: capitalized 1-3 word spans matching known places
  const placePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
  let placeMatch;
  while ((placeMatch = placePattern.exec(message)) !== null) {
    const candidate = placeMatch[1];
    if (DEFAULT_PLACES.some((p) => p.toLowerCase() === candidate.toLowerCase())) {
      places.push({
        value: candidate,
        start: placeMatch.index,
        end: placeMatch.index + candidate.length,
        source: "places",
      });
    }
  }

  // People: use compromise's built-in people detection
  const peopleMatches = doc.people().json();
  for (const m of peopleMatches) {
    const text = m.text;
    const lower = text.toLowerCase();
    if (DEFAULT_PLACES.some((p) => lower.includes(p.toLowerCase()))) continue;
    if (NON_NAME_WORDS.has(lower.split(" ")[0]?.toLowerCase() ?? "")) continue;
    const idx = message.indexOf(text);
    if (idx >= 0) {
      people.push({
        value: text,
        start: idx,
        end: idx + text.length,
        source: "compromise",
      });
    }
  }

  return {
    text: message,
    spans,
    numbers,
    dates,
    places,
    people,
    recentResults,
    message,
  };
}
