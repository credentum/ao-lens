-- BAD: Mutating handler doesn't check State.Frozen
-- Expected: NO_FROZEN_CHECK (medium)

State = State or { Owner = "owner-address", Data = {}, Frozen = false }

Handlers.add("Update", { Action = "Update" }, function(msg)
  -- Has auth check but NO frozen check!
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return end
  State.Data = msg.Data  -- Mutation without frozen check
  msg.reply({ Data = "Updated" })
end)

-- Another handler that DOES check frozen (proves project uses frozen pattern)
Handlers.add("Freeze", { Action = "Freeze" }, function(msg)
  if msg.From ~= State.Owner then return end
  State.Frozen = true
end)
