-- BAD: Mutating handler doesn't check rationale field (Council Amendment #1)
-- Expected: MISSING_RATIONALE_CHECK (medium)

State = State or { Owner = "owner-address", Data = {}, History = {} }

-- This handler DOES check rationale (proves project uses rationale pattern)
Handlers.add("Commit", { Action = "Commit" }, function(msg)
  if msg.From ~= State.Owner then return end
  assert(msg.Tags and msg.Tags.Rationale, "Rationale required")
  State.History[#State.History + 1] = { data = msg.Data, rationale = msg.Tags.Rationale }
end)

-- This handler does NOT check rationale - violation!
Handlers.add("Update", { Action = "Update" }, function(msg)
  if msg.From ~= State.Owner then return end
  -- NO rationale check here! Missing Council Amendment #1 compliance!
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
