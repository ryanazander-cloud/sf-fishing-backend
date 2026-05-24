# SF Bay Fishing Backend

A lightweight API that provides real-time tide, marine weather, and fishing report data for the SF Bay Area fishing dashboard.

## Endpoints

- `GET /health` — health check
- `GET /conditions` — NOAA tides + NWS marine forecast
- `GET /reports?species=salmon&location=ocean` — fishing report search results
- `GET /all?species=salmon&location=ocean` — all data in one call

## Environment Variables

Set these in Railway dashboard under Variables:

| Variable | Description |
|---|---|
| `BRAVE_API_KEY` | Brave Search API key (free tier at brave.com/search/api) |

## Species options
`salmon`, `halibut`, `rockfish`, `seabass`, `crab`

## Location options
`ocean`, `bay`
