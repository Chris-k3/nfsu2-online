# tools/roam_plan.sh plan (run the game with NFSU2_ROAM_CARPOOL_KB=14000, a
# small but valid Cars pool): Sam, Tia and Uma take the three opponent cars;
# Uma quits at 38 s (her car stays parked, wearing her RX8); Pat joins at
# 50 s right next to the player and needs a car of our own, for which there
# is no memory; Uma comes back at 60 s, 200 m away, in the same RX8 (the
# parked car already wears it: no memory needed); Pat leaves at 120 s.
# Expected: Uma is shown again within a few frames of her return, and Pat's
# refusal is logged.  Before the round-3a fix Uma stayed hidden until Pat
# left (int3a-rev-20, int3a-fix-starve-f8b).
( fp 0 --name Sam --stock CIVIC --circle 1708,-874,24.1,5,5 --seconds 200 ) &
( sleep 1; fp 1 --name Tia --stock FOCUS --circle 1716,-868,24.1,5,5 --seconds 200 ) &
( sleep 2; fp 2 --name Uma --stock RX8 --circle 1724,-862,24.1,5,5 --seconds 38; sleep 20
  fp 2 --name Uma --stock RX8 --circle 1900,-880,24.1,6,6 --seconds 100 ) &
( sleep 50; fp 3 --name Pat --stock MUSTANGGT --circle 1700,-880,24.1,3,3 --seconds 70 ) &
