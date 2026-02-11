# Music Downloads: Lidarr + Prowlarr Category Mismatch

If **one song has downloaded** but most music searches find nothing, the usual cause is **indexer categories** not matching between Prowlarr and Lidarr.

## If you see this in Lidarr logs

- **LidarrErrorPipeline:** `Query successful, but no results in the configured categories were returned from your indexer. This may be an issue with the indexer or your indexer category settings.`
- **Artist search completed. 0 reports downloaded** even though you have 3 active indexers
- **RSS Sync Completed. Reports found: 26, Reports grabbed: 0**

That means the indexer (e.g. The Pirate Bay via Prowlarr) is returning results, but Lidarr is rejecting them because those results don’t fall inside the **categories** Lidarr has configured for that indexer. **Prowlarr often doesn't expose category settings for indexers.** The practical fix: set **Prowlarr → Lidarr** sync to **Add or Remove** (not Full Sync) so Lidarr keeps your changes, then add the music category IDs below in **Lidarr** for each indexer.

**When adding or editing an indexer:** The same message can appear when you **save** a new or updated indexer. Lidarr runs a test query with the indexer's categories (e.g. `t=music&cat=3000,3010,...`). If that test returns **no** results, Lidarr refuses to save (CreateProvider/UpdateProvider validation). With Add/Remove sync, set the music categories in Lidarr (see below) so the test returns at least one result.

## What’s going on

- **Prowlarr** manages indexers and syncs them to Lidarr (and Sonarr/Radarr).
- Each indexer has **categories** (Newznab IDs) that define what it’s used for.
- **Lidarr** only uses an indexer for music if that indexer has **music categories** enabled in both:
  1. **Prowlarr** (indexer settings)
  2. **Lidarr** (synced indexer’s categories)

If either side is missing music categories, Lidarr won’t query that indexer for music and you get no (or few) results.

## Standard Newznab music/audio category IDs

| ID   | Name          |
|------|----------------|
| 3000 | Audio (main)  |
| 3010 | Audio/MP3     |
| 3020 | Audio/Video   |
| 3030 | Audio/Audiobook |
| 3040 | Audio/Lossless |
| 3050 | Audio/Other   |
| 3060 | Audio/Foreign |

Lidarr typically uses at least **3000, 3010, 3020, 3030** for music.

## Fix in Prowlarr

1. Open **Prowlarr** → **Indexers**.
2. For each indexer you use for music:
   - Edit the indexer.
   - Under **Categories**, enable the **Music/Audio** categories (or the specific subcategories your indexer supports, e.g. 3000, 3010, 3020, 3030).
   - Save.
3. **Sync to Apps**: **Settings** → **Apps** → your Lidarr app → **Sync App Indexers** (or **Test** then **Sync**) so Lidarr gets the updated categories.

## Fix in Lidarr

1. Open **Lidarr** → **Settings** → **Indexers**.
2. For each indexer (synced from Prowlarr):
   - Click the indexer.
   - Ensure **Categories** includes the music categories above (e.g. 3000, 3010, 3020, 3030). If the list is empty or only has non-music categories, add the music ones.
   - Save.

If you use **full sync** from Prowlarr, Lidarr’s indexer list is overwritten by Prowlarr. So:

- Fix categories **in Prowlarr** first, then sync to Lidarr, **or**
- Use **Add/Remove** sync in Prowlarr→Lidarr so you can adjust categories in Lidarr without them being overwritten.

## Artist doesn't show in Lidarr search but does in Prowlarr

**Different pipelines.** They do different jobs:

| Where you search | What it uses | Purpose |
|------------------|--------------|---------|
| **Lidarr** (Add New / search artist) | **MusicBrainz** (metadata API), not indexers | Build the list of *artists* Lidarr knows about |
| **Prowlarr** (search) | **Indexers** (TPB, etc.) | Find *releases* (albums, torrents) to download |

So if an artist **doesn't show in Lidarr** but **does in Prowlarr**, Lidarr isn't missing indexers — it's that **Lidarr's artist list comes from MusicBrainz**, not from your indexers. If MusicBrainz doesn't have the artist (or Lidarr can't reach it), the artist won't appear in Lidarr search even though indexers have releases.

**What to do:**

1. **Check MusicBrainz has the artist** — Search on [musicbrainz.org](https://musicbrainz.org). If the artist isn't there, Lidarr will never show them. Some very niche or non-Western artists are missing or under different names.
2. **Check Lidarr can reach MusicBrainz** — Lidarr → Settings → Metadata. Lidarr uses MusicBrainz by default; if your host can't reach musicbrainz.org (firewall, DNS, proxy), artist search will be empty. Test from the same machine (e.g. `curl -I https://musicbrainz.org`).
3. **Try different search terms** — Use the exact name as on MusicBrainz, or try the artist's MusicBrainz ID if you find it (e.g. in Lidarr: "lidarr:mbid-…" once you have the MBID).
4. **Add by album instead (if available)** — Some Lidarr setups let you add via "Add New" → search by album or release; that can sometimes resolve to an artist that doesn't show when searching by name.
5. **Indexers are for *releases*, not artist list** — Fixing Prowlarr/Lidarr indexer categories (above) fixes "I have the artist in Lidarr but no downloads." It does **not** fix "the artist doesn't appear in Lidarr at all." That's a MusicBrainz/metadata/connectivity issue.

## Quick check from Jeeves

You can ask Jeeves: **“music indexer status”** or **“lidarr prowlarr categories”** (if that homelab action is enabled). It will report which indexers have music categories in Prowlarr and in Lidarr so you can see mismatches.

## References

- [Newznab predefined categories](https://inhies.github.io/Newznab-API/categories/)
- Prowlarr: Indexer settings → Categories
- Lidarr: Settings → Indexers → [indexer] → Categories
