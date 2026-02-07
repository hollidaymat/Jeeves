/**
 * PRD Generator
 * 
 * Generates a full Product Requirements Document (PRD) as markdown
 * from a ClientData record. Used to drive Cursor Background Agent builds.
 * 
 * Optionally calls Haiku for custom copy (budget-enforced via 'prd_builder').
 */

import { logger } from '../../utils/logger.js';
import { enforceBudget, recordFeatureUsage, getFeatureMaxTokens } from '../../core/cost-tracker.js';
import type { ClientData } from './client-template.js';
import { PAGE_MAP } from './client-template.js';

// ============================================================================
// PRD Generation
// ============================================================================

/**
 * Generate a full PRD markdown string for a DiveConnect client site.
 */
export function generateClientPRD(client: ClientData): string {
  const pages = PAGE_MAP[client.businessType];
  const businessLabel = formatBusinessType(client.businessType);

  const prd = `# ${client.businessName} — Site PRD

## Overview

Build a modern, responsive website for **${client.businessName}**, a ${businessLabel} located in **${client.location}**.

- **Business Type:** ${businessLabel}
- **Subdomain:** ${client.subdomain}
- **Services:** ${client.services.join(', ')}
${client.boats ? `- **Boats:** ${client.boats}` : ''}
${client.certifications?.length ? `- **Certifications:** ${client.certifications.join(', ')}` : ''}

---

## Pages

${pages.map((page) => `### ${capitalize(page)}\n${getPageDescription(page, client)}`).join('\n\n')}

---

## Design

- **Framework:** Next.js 16 (App Router)
- **Styling:** Tailwind CSS v4
- **Components:** shadcn/ui
- **Theme:** Ocean/diving aesthetic${client.colorOverride ? ` — primary color override: ${client.colorOverride}` : ''}
  - Primary palette: deep blues, teals, and coral accents
  - Clean typography with good readability
  - High-quality imagery placeholders for diving content
- **Responsive:** Mobile-first, fully responsive across all breakpoints
- **Dark Mode:** Optional toggle, default to light theme

---

## Features

- **Responsive Design:** Mobile-first layout that works across all devices and screen sizes
- **SEO Optimization:** Meta tags, Open Graph, structured data (JSON-LD), sitemap.xml, robots.txt
- **Contact Form:** Email submission form with validation and success feedback
- **Image Gallery:** Lightbox-style gallery with lazy loading and optimized images
- **Google Maps Integration:** Embedded map showing business location in ${client.location}
- **Booking Widget:** Call-to-action booking section with form or external booking link
${client.socialMedia ? `- **Social Media Links:** ${Object.keys(client.socialMedia).join(', ')}` : ''}
- **Performance:** Lighthouse score target > 90 on all metrics
- **Accessibility:** WCAG 2.1 AA compliance

---

## Deployment

- **Platform:** Vercel
- **Subdomain:** \`${client.subdomain}\`${client.customDomain ? `\n- **Custom Domain:** \`${client.customDomain}\`` : ''}
- **CI/CD:** Auto-deploy on push to \`main\` branch
- **Monitoring:** Vercel Analytics enabled
- **Security:**
  - HTTPS enforced
  - Content Security Policy headers
  - Rate limiting on form submissions
  - No exposed API keys or secrets
`;

  logger.info('PRD generated', {
    client: client.slug,
    businessType: client.businessType,
    pageCount: pages.length,
  });

  return prd;
}

// ============================================================================
// Helpers
// ============================================================================

function formatBusinessType(type: string): string {
  const labels: Record<string, string> = {
    dive_shop: 'Dive Shop',
    resort: 'Dive Resort',
    liveaboard: 'Liveaboard',
    instructor: 'Dive Instructor',
  };
  return labels[type] || type;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Returns a brief description for each page type based on business context.
 */
function getPageDescription(page: string, client: ClientData): string {
  const name = client.businessName;
  const loc = client.location;

  const descriptions: Record<string, string> = {
    home: `Hero section with stunning diving imagery, tagline, quick overview of ${name}, and call-to-action buttons for booking and exploring services.`,
    courses: `List of available dive courses and certifications offered by ${name}. Include pricing tiers, duration, prerequisites, and enrollment CTA.`,
    trips: `Upcoming dive trips and excursions from ${loc}. Show dates, destinations, difficulty levels, and booking options.`,
    equipment: `Equipment rental and retail offerings. Show categories, brands, pricing, and rental terms.`,
    about: `Story of ${name}, team bios, mission statement, and years of experience in ${loc}.`,
    contact: `Contact form, phone, email, address, business hours, and embedded Google Maps for ${loc}.`,
    booking: `Online booking form or integration point. Date picker, service selection, group size, and confirmation flow.`,
    rooms: `Room types and accommodation options. Photos, amenities, pricing, and availability calendar.`,
    diving: `Dive sites accessible from the resort, conditions, marine life highlights, and dive packages.`,
    dining: `Restaurant and dining options. Menus, meal plans, dietary accommodations, and ambiance photos.`,
    activities: `Non-diving activities available: snorkeling, kayaking, spa, excursions, and local tours.`,
    gallery: `Photo and video gallery showcasing diving experiences, marine life, facilities, and guest moments.`,
    vessel: `Vessel specifications, deck plans, safety equipment, amenities, and capacity details.`,
    itineraries: `Available trip itineraries with day-by-day breakdown, dive sites, and included meals/activities.`,
    cabins: `Cabin types, layouts, amenities, and pricing. Include photos and deck location maps.`,
    certifications: `Instructor certifications, training philosophy, and specializations. Show certification logos and counts.`,
    schedule: `Upcoming classes, availability calendar, and booking links for private and group sessions.`,
    testimonials: `Student and client reviews, ratings, and success stories with photos where available.`,
  };

  return descriptions[page] || `Content page for ${page}.`;
}

/**
 * Optionally generate custom marketing copy via Haiku (budget-enforced).
 * Falls back to static descriptions if budget is exhausted.
 */
export async function generateCustomCopy(
  client: ClientData,
  section: string
): Promise<string | null> {
  const budget = enforceBudget('prd_builder');
  if (!budget.allowed) {
    logger.debug('PRD custom copy skipped — budget exhausted', {
      reason: budget.reason,
      client: client.slug,
      section,
    });
    return null;
  }

  const maxTokens = getFeatureMaxTokens('prd_builder');

  try {
    // Haiku call would go here — for now return null to use static descriptions
    // This is a placeholder for future AI-generated marketing copy
    logger.debug('Custom copy generation placeholder', {
      client: client.slug,
      section,
      maxTokens,
    });

    // Record usage when actual LLM call is made
    // recordFeatureUsage('prd_builder', estimatedCost);

    return null;
  } catch (error) {
    logger.warn('Custom copy generation failed', {
      error: String(error),
      client: client.slug,
      section,
    });
    return null;
  }
}
