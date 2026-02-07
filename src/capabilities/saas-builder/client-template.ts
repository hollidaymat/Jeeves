/**
 * Client Template System
 * 
 * Defines data structures and templates for DiveConnect client sites.
 * Each client gets a customized dive business website based on their type.
 */

export type BusinessType = 'dive_shop' | 'resort' | 'liveaboard' | 'instructor';
export type ClientStatus = 'building' | 'live' | 'paused' | 'archived';

export interface ClientData {
  id: string;
  businessName: string;
  slug: string;
  businessType: BusinessType;
  location: string;
  services: string[];
  boats?: number;
  certifications?: string[];
  socialMedia?: Record<string, string>;
  colorOverride?: string | null;
  customDomain?: string | null;
  // Generated
  repoName: string;
  subdomain: string;
  vercelProjectId?: string;
  githubRepo?: string;
  status: ClientStatus;
  deployedAt?: string;
  lastChecked?: string;
  createdAt: string;
}

/**
 * Create a new ClientData record from basic business input.
 * Generates slug, repo name, subdomain, and default status.
 */
export function createClientFromInput(
  businessName: string,
  location: string,
  businessType: BusinessType,
  services: string[]
): ClientData {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    id: crypto.randomUUID(),
    businessName,
    slug,
    businessType,
    location,
    services,
    repoName: `diveconnect-${slug}`,
    subdomain: `${slug}.diveconnect.ai`,
    status: 'building',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Maps each business type to the pages that should be generated.
 */
export const PAGE_MAP: Record<BusinessType, string[]> = {
  dive_shop: ['home', 'courses', 'trips', 'equipment', 'about', 'contact', 'booking'],
  resort: ['home', 'rooms', 'diving', 'dining', 'activities', 'gallery', 'booking'],
  liveaboard: ['home', 'vessel', 'itineraries', 'cabins', 'gallery', 'booking'],
  instructor: ['home', 'about', 'certifications', 'schedule', 'testimonials', 'contact'],
};
