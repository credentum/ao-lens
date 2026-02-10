-- BAD: Matcher has auth but handler body lacks assert (missing belt-and-suspenders)
-- Expected: MISSING_BELT_AND_SUSPENDERS (medium)

State = State or { Owner = "owner-address", Data = {} }

-- Matcher checks authorization but body doesn't have redundant assert
Handlers.add("Update", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if msg.From ~= State.Owner then return false end  -- Auth in matcher
  return true
end, function(msg)
  -- NO assert(msg.From == State.Owner) here! Missing suspenders!
  State.Data = msg.Data
  msg.reply({ Data = "Updated" })
end)
