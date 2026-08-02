/**
 * Every word on the site lives here. Edit this file to change the copy —
 * no component changes required.
 */

export interface StatementSectionContent {
  /** Anchor id used by the nav. */
  id: string;
  /** Short label shown in the nav. */
  navLabel: string;
  /** Small overline above the heading. */
  eyebrow: string;
  heading: string;
  /** Opening paragraph, set larger than the rest. */
  lede: string;
  /** Supporting paragraphs. */
  body: string[];
  /** Three short phrases shown beneath the copy. */
  notes: string[];
}

export interface SocialLink {
  label: string;
  href: string;
}

export const site = {
  name: 'DLARTCOMPANY',
  legalName: 'DLARTCOMPANY LLC',
  domain: 'dlartcompany.com',
  url: 'https://www.dlartcompany.com',
  tagline: 'An independent studio making games, books, and art.',
  description:
    'DLARTCOMPANY LLC is an independent creative studio working across game design, technical writing, and visual art.',
  email: 'support@dlartcompany.com',
} as const;

export const hero = {
  eyebrow: 'Independent creative studio',
  headingLines: ['Games.', 'Books.', 'Art.'],
  lede: 'DLARTCOMPANY is an independent studio built around three ways of working through the same ideas — games you play, technical books you learn from, and art you look at.',
  scrollCue: 'Scroll',
} as const;

export const sections: StatementSectionContent[] = [
  {
    id: 'games',
    navLabel: 'Games',
    eyebrow: 'Design',
    heading: 'Games that trust the player',
    lede: 'We design games that give players room to think. The interesting part of a game is rarely the instruction — it is the moment someone works something out for themselves.',
    body: [
      'Our work tends toward systems over scripts. We build rules that interact, then let the interesting situations emerge from the play rather than staging them in advance. That means fewer things happen to the player and more things happen because of them.',
      'Every project starts the same way: a mechanic that feels good in the hand, and a question worth asking. Everything else — art direction, structure, pacing — grows outward from those two things until the whole holds together.',
    ],
    notes: ['Systems-led design', 'Emergent, not scripted', 'Built small and iterated'],
  },
  {
    id: 'books',
    navLabel: 'Books',
    eyebrow: 'Writing',
    heading: 'Technical books that explain the why',
    lede: 'We write non-fiction and technical books. Different form, same instinct as the games: build something with internal logic, then explain it honestly enough that a reader can reason about it themselves.',
    body: [
      'Most technical writing stops at the procedure. We are more interested in the model underneath it — why a system is shaped the way it is, which tradeoffs produced it, and what breaks when you push on it. Readers who understand that can solve the problems the book never anticipated.',
      'The work is unhurried and heavily edited. We build the examples, run them, and cut anything we cannot defend. We would rather ship a book that is correct and clear than one that is on schedule.',
    ],
    notes: ['Non-fiction and technical', 'Concepts over recipes', 'Examples we actually ran'],
  },
  {
    id: 'art',
    navLabel: 'Art',
    eyebrow: 'Visual work',
    heading: 'Art as the foundation, not the finish',
    lede: 'Visual work runs through everything the studio makes. It is not decoration applied at the end — it is usually where a project starts.',
    body: [
      'We work across digital painting, illustration, and design, with an eye toward mood and atmosphere over spectacle. A strong image sets the temperature for a whole project: what it feels like to be there, and what kind of story the place could hold.',
      'Much of the art exists to serve games and books in progress. Some of it stands alone. Either way it comes from the same practice and the same hand, which is why the studio\u2019s work looks like a single body of work rather than three unrelated ones.',
    ],
    notes: ['Digital painting', 'Mood over spectacle', 'One consistent hand'],
  },
];

export const about = {
  id: 'about',
  navLabel: 'About',
  eyebrow: 'About the studio',
  heading: 'Three disciplines, one practice',
  lede: 'DLARTCOMPANY LLC is a small independent studio. Games, technical books, and art are not separate departments here — they are three tools reaching for the same thing.',
  body: [
    'Working across all three is deliberate. A problem that stalls in one medium often resolves in another: an idea that resists explanation on the page usually becomes obvious once it is a system you can play with, and a diagram will frequently answer a design question faster than a document.',
    'Staying independent is what makes that possible. We keep the studio small, own the work outright, and choose projects on whether they are worth making rather than whether they fit a category.',
  ],
  notes: ['Independent and self-funded', 'Small by choice', 'Work chosen, not assigned'],
} as const;

export const contact = {
  id: 'contact',
  navLabel: 'Contact',
  eyebrow: 'Get in touch',
  heading: 'Say hello',
  lede: 'Open to collaborations, commissions, publishing conversations, and the occasional good idea with no obvious home. The inbox is read personally.',
  ctaLabel: 'Email the studio',
} as const;

/**
 * Update these with real profiles as they come online. Entries with an empty
 * `href` are skipped at render time, so it is safe to leave one blank.
 */
export const socials: SocialLink[] = [
  { label: 'Bluesky', href: '' },
  { label: 'Instagram', href: '' },
  { label: 'GitHub', href: 'https://github.com/safreita' },
];

/** Section order for the nav, derived so the two can never drift apart. */
export const navItems = [
  ...sections.map(({ id, navLabel }) => ({ id, navLabel })),
  { id: about.id, navLabel: about.navLabel },
  { id: contact.id, navLabel: contact.navLabel },
];
