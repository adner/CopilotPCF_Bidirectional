# Dataverse schema (curated) — the model's world for query generation

This document is injected verbatim into the visualization-generation prompt. It is the **only**
schema the model knows about. Keep it small, accurate, and in sync with the target Dataverse
environment. Add a table here before expecting the model to chart it.

The data path is the **TDS (SQL) endpoint** — write **T-SQL** (`SELECT` only). Table and column
names below are Dataverse **logical names**, which are the SQL table/column names on the TDS endpoint.

---

## Table: `opportunity`  (sales opportunities)

| Column | Type | Meaning |
|---|---|---|
| `opportunityid` | uniqueidentifier | Primary key |
| `name` | nvarchar | Opportunity title |
| `estimatedvalue` | money | Estimated revenue |
| `actualvalue` | money | Actual revenue (closed) |
| `createdon` | datetime | When the record was created |
| `estimatedclosedate` | datetime | Expected close date |
| `statecode` | int | 0 = Open, 1 = Won, 2 = Lost |
| `statuscode` | int | Detailed status reason |

Notes:
- "Most recently created N" → `ORDER BY createdon DESC` with `SELECT TOP (N)`.
- "Open opportunities" → `WHERE statecode = 0`.

## Table: `contact`  (people)

| Column | Type | Meaning |
|---|---|---|
| `contactid` | uniqueidentifier | Primary key |
| `fullname` | nvarchar | Display name |
| `gendercode` | int | 1 = Male, 2 = Female (may be null) |
| `createdon` | datetime | When the record was created |
| `address1_city` | nvarchar | City |

Notes:
- "Women vs men" → `GROUP BY gendercode` and map 1→Male, 2→Female in the query aliases.

---

## Example NL → SQL

- *"the value of the 5 most recently created opportunities in a bar chart"*
  ```sql
  SELECT TOP (5) name AS label, estimatedvalue AS value
  FROM opportunity
  ORDER BY createdon DESC;
  ```
- *"a pie chart of the number of women versus men in the contact database"*
  ```sql
  SELECT CASE gendercode WHEN 1 THEN 'Male' WHEN 2 THEN 'Female' ELSE 'Unknown' END AS label,
         COUNT(*) AS value
  FROM contact
  GROUP BY gendercode;
  ```
- *"open opportunities by month this year as a line chart"*
  ```sql
  SELECT FORMAT(createdon, 'yyyy-MM') AS label, COUNT(*) AS value
  FROM opportunity
  WHERE statecode = 0
  GROUP BY FORMAT(createdon, 'yyyy-MM')
  ORDER BY label;
  ```

**Convention:** prefer returning two friendly columns — a category as `label` and a number as
`value` — plus any extra series columns needed. The chart render function receives these rows as-is.
