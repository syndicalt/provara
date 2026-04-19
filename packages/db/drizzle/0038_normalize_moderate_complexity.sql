-- Normalize legacy `moderate` complexity values to `medium`.
-- The Complexity enum is ("simple" | "medium" | "complex"), but before
-- runtime validation of routing hints landed, callers that sent
-- `complexity_hint: "moderate"` wrote that string straight through to
-- `requests.complexity` and downstream `model_scores.complexity`. The
-- adaptive heatmap keys cells on the enum values, so "moderate" rows
-- never rendered. Normalizing to the closest valid value ("medium")
-- makes the historical data visible again without discarding it.
UPDATE requests SET complexity = 'medium' WHERE complexity = 'moderate';
--> statement-breakpoint
UPDATE model_scores SET complexity = 'medium' WHERE complexity = 'moderate';
