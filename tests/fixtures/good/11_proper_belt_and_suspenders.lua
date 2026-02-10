-- GOOD: Handler has auth in BOTH matcher AND body (belt-and-suspenders)
-- NotExpected: MISSING_BELT_AND_SUSPENDERS

State = State or { Owner = "owner-address", Data = {} }

Handlers.add("Update", function(msg)
  -- Proper nil guards in matcher
  if not msg.Tags or msg.Tags.Action ~= "Update" then return false end
  if not State.Owner or not msg.From or msg.From ~= State.Owner then return false end  -- Belt: auth in matcher
  return true
end, function(msg)
  -- Suspenders: redundant auth check in body
  assert(State.Owner and msg.From and msg.From == State.Owner, "Unauthorized")
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
