-- GOOD: Mutating handler properly checks State.Frozen
-- Expected: NO findings

State = State or { Owner = "owner-address", Data = {}, Frozen = false }

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Auth check with proper nil guards
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end
  -- Proper frozen check!
  assert(not State.Frozen, "Process is frozen")
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)

-- Freeze handler also checks frozen (idempotent - can only freeze once)
Handlers.add("Freeze", { Action = "Freeze" }, function(msg)
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end
  if State.Frozen then return end  -- Already frozen, no-op
  State.Frozen = true
end)
