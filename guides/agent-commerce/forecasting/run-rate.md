# Revenue run-rate and trend

How to project forward from `agent_commerce_marts.main.monthly_spend`. Filed
under `agent-commerce/forecasting` — a nested topic, so opening
`agent-commerce` surfaces it alongside the metrics guide.

## Rules

- **Forecast from the gold table, not from raw transactions.**
  `agent_commerce_marts.main.monthly_spend` is already filtered to authorized
  transactions and refreshed weekly by the `agent-commerce-monthly-rollup`
  Flight.
- **Exclude the current month from any run-rate.** A partial month drags the
  average down and makes growth look negative. Filter to complete months.
- **Use a trailing 3-month mean, not last month alone.** Single-month figures in
  this dataset swing by more than 10% month to month.
- **Do not annualize from fewer than three complete months.** There is not
  enough signal, and the result will be presented as if there were.

## Query patterns

Month-over-month growth:

```sql
SELECT month,
       authorized_spend,
       lag(authorized_spend) OVER (ORDER BY month) AS prev_month,
       round(100.0 * (authorized_spend - lag(authorized_spend) OVER (ORDER BY month))
             / nullif(lag(authorized_spend) OVER (ORDER BY month), 0), 1) AS mom_pct
FROM agent_commerce_marts.main.monthly_spend
ORDER BY month;
```

Trailing 3-month run-rate, annualized:

```sql
WITH complete AS (
  SELECT * FROM agent_commerce_marts.main.monthly_spend
  WHERE month < strftime(now(), '%Y-%m')      -- drop the partial current month
  ORDER BY month DESC LIMIT 3
)
SELECT round(avg(authorized_spend), 2)      AS avg_monthly,
       round(avg(authorized_spend) * 12, 2) AS annualized_run_rate,
       count(*)                             AS months_used
FROM complete;
```

## Caveat for this dataset

The source is a frozen 2024 snapshot, so every month is complete and nothing
moves between runs. The `month < strftime(now(), '%Y-%m')` filter is a no-op
here and is kept deliberately: copy this pattern onto live data and the partial
current month is the first thing that will distort your numbers.
