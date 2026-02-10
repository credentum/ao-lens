-- GOOD: All mutating handlers check rationale field (Council Amendment #1)
-- NotExpected: MUTATING_HANDLER_NO_RESPONSE

State = State or { Owner = "owner-address", Data = {}, History = {} }

Handlers.add("Commit", { Action = "Commit" }, function(msg)
  -- Proper nil guards
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end
  assert(msg.Tags and msg.Tags.Rationale, "Rationale required")  -- Assert guards subsequent access
  State.History[#State.History + 1] = { data = msg.Data, rationale = msg.Tags.Rationale }
  msg.reply({ Data = "Committed" })
end)

-- This handler ALSO checks rationale - consistent compliance!
Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Proper nil guards
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end
  assert(msg.Tags and msg.Tags.Rationale, "Rationale required per Council Amendment #1")
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
