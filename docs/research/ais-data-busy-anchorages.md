# Historic AIS data for busy sailboat anchorages

Research for signalk-anchor-mapper, 2026-11-19. Everything below comes from reading the sources' own pages. I did NOT download any sample: the research environment was blocked from the data hosts (NOAA, DMA, Zenodo), so class B density is unverified for every dataset. Items marked (unverified) were not confirmed on a page.

## Ranking: anchorage + dataset pairs

| # | Anchorage | Dataset | Why | Main risk |
|---|-----------|---------|-----|-----------|
| 1 | US Virgin Islands: Cruz Bay / Great Cruz Bay (St John), Charlotte Amalie, Christmas Cove, Coral Bay; Puerto Rico: Culebra (Dewey, Ensenada Honda), Fajardo/Vieques | NOAA MarineCadastre AIS, custom clip via AccessAIS | Free, 1-minute positions, any area and date range, USVI and PR named in the 2024 and 2025 track metadata. Very dense charter and cruiser anchorages. | Class B inclusion (TransceiverClass A/B) not confirmed on the pages read. Receivers are USCG shore stations, so coverage inside bays may be patchy. |
| 2 | Florida Keys (Key West, Boot Key Harbor/Marathon), Chesapeake (Annapolis, Solomons), Newport RI, San Diego, Pacific NW / San Juan Islands, Hawaii (Ala Wai, Lahaina) | Same NOAA set | Same free access. Lots of class B on the US east and west coasts, and live-aboard mooring fields (Boot Key, Annapolis) test the "moored vs anchored" distinction. | Same two risks. Many US yachts transmit class B only intermittently. |
| 3 | Saronic Gulf (Aegina, Poros, Epidavros, Salamina) | Piraeus AIS dataset, Zenodo (doi 10.5281/zenodo.5562629 per the paper) | Free, raw timestamps, 2017-05 to 2019-12, 244 M records, message types 18/19 (class B) included, sailing vessels and pleasure craft (types 36/37) appear in the vessel-type list. Mediterranean, closest in character to the Spanish Mediterranean coast the current validation data comes from. | CC BY-NC-SA 4.0 (non-commercial, share-alike). MMSI replaced by an artificial id, which is fine for per-vessel tracks. One receiver in Piraeus, about 10,000 km2, so far islands may be thin. 30 GB. |
| 4 | Danish summer anchorages (Aeroe, Svendborg, Faaborg, Limfjord, Anholt, Sejeroe) | Danish Maritime Authority open AIS archive | Free, whole country, class A and B both in scope ("Type of mobile" column), raw per-message CSV, about 580 MB a day. | Only a limited window of data stays online (older than 24 months is packed and offered "for a limited period"). Danish anchorages are seasonal and less crowded than the Caribbean. Download host differs between pages (aisdata.ais.dk vs web.ais.dk). |
| 5 | Anywhere, live | aisstream.io | Free, class B message types supported, bounding box required, global. Good for starting a fresh recorder in a target anchorage. | Live only, no history. No SLA, no licence terms found. Same as running your own receiver. |
| 6 | Caribbean, Med, Pacific (Le Marin, Bequia, Rodney Bay, Porquerolles, Balearic calas, Opua) | Commercial: Spire (historical shop), MarineTraffic, Kpler, Datalastic | The only route to non-US, non-Danish anchorages. | Cost not found: the Spire shop URL redirected to Kpler and I did not follow it. Datalastic prices did not render. Satellite-heavy products are downsampled and weak in crowded harbours. Not recommended before exhausting 1 to 4. |
| - | Norway | Kystverket public CSV | Not useful. The public set covers only ships over 45 m within 12 nm. Full data needs a registration with a stated purpose, and recreational craft under 45 m carry use restrictions. | |

Anchorages named above are from general sailing knowledge, not from a data-density check.

## Source details

### NOAA MarineCadastre (US, incl. territories)
- Coverage: contiguous US, Hawaii, Puerto Rico, USVI (2024 track metadata); 2025 adds Guam. DigitalCoast says "coastal areas of the contiguous U.S., Alaska, Hawaii, and U.S. territories".
- Resolution: 1 minute (downsampled).
- Class B: 2019 CSV lists a TransceiverClass attribute (values only in the data dictionary PDF, not read). The 2024/2025 point-level fields were not read. Unverified for both.
- Formats: daily zipped CSV (older), daily GeoParquet for 2024 and 2025 (max ~325 MB per file), monthly vessel tracks. Bulk lists from 2009 on.
- Area clip: AccessAIS ("clip and ship", custom area and time, order cap about 2 GB, zipped CSV). Only the most recent years are offered, and the oldest is dropped when a new one is added.
- Cost: free. Licence: no named licence, use constraint "for coastal and ocean planning", access constraints none (2019 record). Check the disclaimer page before anything commercial.
- Links: https://marinecadastre.gov/accessais/ , https://hub.marinecadastre.gov/pages/vesseltraffic , https://github.com/ocm-marinecadastre/ais-vessel-traffic , 2024 daily path https://ocmgeodatastor1.blob.core.windows.net/marinecadastre/ais2024/ , tracks https://ocmgeodatastor1.blob.core.windows.net/marinecadastre/aistrack/ , 2019 CSV index https://noaaocm.blob.core.windows.net/ais/csv2/csv2019/index.html , InPort 2024 field dictionary https://www.fisheries.noaa.gov/inport/item/73064
- Note: the GitHub repo is marked archived/read-only.

### Piraeus AIS dataset
- Paper: https://pmc.ncbi.nlm.nih.gov/articles/PMC8749179/ . Data: https://zenodo.org/records/6323416 (I could not open this record; the paper cites https://doi.org/10.5281/zenodo.5562629, check which is current).
- Fields: timestamp (ms), vessel_id, lon, lat, heading, course, speed. Monthly CSV, 32 files. Raw rate, at anchor about 3 min per report.
- Licence CC BY-NC-SA 4.0.

### Danish Maritime Authority
- Pages: https://dma.dk/safety-at-sea/navigational-information/ais-data , policy https://www.dma.dk/safety-at-sea/navigational-information/ais-data/ais-data-management-policy- , download http://aisdata.ais.dk/ or https://web.ais.dk/aisdata/ (not opened).
- Daily zipped CSV, free, PSI-act terms (no CC licence named, no combining that makes persons identifiable). Columns per a workshop page: Timestamp, Type of mobile, MMSI, lat/lon, SOG, COG, heading, name, ship type, etc.
- Years available not stated on the pages. Check the index before planning.

### aisstream.io
- https://aisstream.io , docs https://aisstream.io/documentation . Free with a GitHub login and API key. Live only. 3 connections per account, bounding boxes required, no SLA, no licence page found. Coverage network not described.

### Paid
- Spire historical (per-message files, satellite + terrestrial, delivered via Google Cloud Storage; a 2021 FAQ says one global day was about 34 GB compressed): https://faq.spire.com/migration/historical-ais-file-sizes . Shop redirects to https://www.kpler.com/product/maritime/kplerais . No prices found.
- Datalastic API (credit based, historical area scan listed, no dollar prices read): https://datalastic.com/pricing/
- MarineTraffic historical track API (not read in detail): https://servicedocs.marinetraffic.com/tag/Vessel-Historical-Track
- VesselFinder historical AIS: https://www.vesselfinder.com/historical-ais-data (not read).

## Suggested next steps
1. Order a small AccessAIS clip (for example Great Cruz Bay, St John, one summer month) and check TransceiverClass and density. This is the cheapest decisive test. It needs a browser, so run it from a desktop browser.
2. In parallel pull one Piraeus monthly file and look at Aegina and Poros.
3. Only if those fail, ask Spire/Kpler for a quote on one anchorage.
