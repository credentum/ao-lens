-- BAD: Using math.random() which is non-deterministic
-- Expected: MATH_RANDOM_UNSEEDED (high) at line 7

State = State or { Value = 0 }

Handlers.add("Randomize", { Action = "Randomize" }, function(msg)
  State.Value = math.random(1, 100)  -- NON-DETERMINISTIC! Use msg.Id as seed
  msg.reply({ Data = tostring(State.Value) })
end)
