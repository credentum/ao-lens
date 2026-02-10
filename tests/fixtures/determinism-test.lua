-- Test file for determinism violation detection

State = {
  Counter = 0,
  LastTime = 0,
  RandomValue = 0
}

-- Handler with os.time() - determinism violation
Handlers.add("BadTimer", function(msg)
  return msg.Tags.Action == "BadTimer"
end, function(msg)
  -- os.time() breaks replay safety!
  State.LastTime = os.time()
  ao.send({ Target = msg.From, Action = "TimerSet" })
end)

-- Handler with math.random() - determinism violation
Handlers.add("RandomHandler", function(msg)
  return msg.Tags.Action == "Random"
end, function(msg)
  -- math.random() breaks replay safety!
  State.RandomValue = math.random(1, 100)
  ao.send({ Target = msg.From, Action = "RandomSet", Data = tostring(State.RandomValue) })
end)

-- Handler with io operations - not available in AO
Handlers.add("FileHandler", function(msg)
  return msg.Tags.Action == "ReadFile"
end, function(msg)
  -- io operations are not available in AO!
  local content = io.read("data.txt")
end)

-- Good handler using msg.Timestamp instead of os.time()
Handlers.add("GoodTimer", Handlers.utils.hasMatchingTag("Action", "GoodTimer"), function(msg)
  -- Use msg.Timestamp for deterministic time
  State.LastTime = msg.Timestamp
  ao.send({ Target = msg.From, Action = "TimerSet" })
end)
