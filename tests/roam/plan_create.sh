# tools/roam_plan.sh plan (run the game with NFSU2_ROAM_CARPOOL_KB=14000):
# three friends hold the opponent cars and change their car every 8 s (ten
# new looks each, then the same one; the cycle restarts after 16 looks); Pat
# joins at 100 s and needs a car of our own (CreateCar) while the pool is
# short.  Expected: every refusal is logged and names its friend, Pat's
# included (before the round-3a fix Pat got no line at all and the one
# rate-limited note named whoever hit it first: int3a-rev-16,
# int3a-fix-create-f8b).
L1=FOCUS,RX8,3000GT,MUSTANGGT,350Z,GTO,SKYLINE,IMPREZAWRX,LANCEREVO8,CELICA,CELICA,CELICA,CELICA,CELICA,CELICA,CELICA
L2=RX8,3000GT,MUSTANGGT,350Z,GTO,SKYLINE,IMPREZAWRX,LANCEREVO8,ECLIPSE,G35,G35,G35,G35,G35,G35,G35
L3=3000GT,MUSTANGGT,350Z,GTO,SKYLINE,IMPREZAWRX,LANCEREVO8,ECLIPSE,G35,SENTRA,SENTRA,SENTRA,SENTRA,SENTRA,SENTRA,SENTRA
( fp 0 --name Sam --stock CIVIC --looks $L1 --look-every 8 --circle 1708,-874,24.1,5,5 --seconds 260 ) &
( sleep 1; fp 1 --name Tia --stock FOCUS --looks $L2 --look-every 8 --circle 1716,-868,24.1,5,5 --seconds 260 ) &
( sleep 2; fp 2 --name Uma --stock RX8 --looks $L3 --look-every 8 --circle 1724,-862,24.1,5,5 --seconds 260 ) &
( sleep 100; fp 3 --name Pat --stock PEUGOT --circle 1690,-870,24.1,6,6 --seconds 120 ) &
