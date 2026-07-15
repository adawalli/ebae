# eBay link exclusions

## Goal

Make each saved-search eBay link reflect its configured title exclusions.

## Behavior

`ebayWebUrl()` will parse `excludeTerms` as the poller does: comma/newline-separated entries, with surrounding whitespace removed and blank entries ignored. Each phrase becomes a quoted negative eBay keyword in `_nkw`.

For example, a search for `mac mini m4` excluding `16gb` and `256gb` opens with:

```
mac mini m4 -"16gb" -"256gb"
```

An exclusion such as `for parts` remains one negative phrase: `-"for parts"`.

## Scope

- Extend the link helper's input type to include `excludeTerms`.
- Add the negative phrases while retaining the existing marketplace, category, sort, buying-option, and price parameters.
- Add focused unit coverage for comma/newline exclusions and the no-exclusions case.

No database, API, poller, or UI changes are needed.
