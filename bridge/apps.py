"""App catalogue for the living room TV.

`jw` lists the JustWatch package names (technicalName) that map to this app, so the show finder
knows which app opens which offer. `deeplink` says how a show opens in it, as tested on this TV
(see DEEPLINKS.md): "jw" means the JustWatch Android TV intent works, "search" means open the app
and search, "app" means only the app opens. `use_web` (a regex) opens the JustWatch web link cut
down to the show page instead of the intent; `cold` restarts the app first so it takes the link
("background" restarts it only when it is not on screen). `verify` waits until the app says it is
really playing before the bridge says so.
"""

APPS = [
    # Netflix left in the background for a while asks "Who's watching?" when a link brings it
    # back, and then drops the show. Started fresh it goes straight
    # to the show, resumed where the profile was up to, in about 20 s (DEEPLINKS.md).
    {"id": "netflix", "name": "Netflix", "package": "com.netflix.ninja", "colour": "#E50914",
     "jw": ["netflix", "netflixbasicwithads", "netflixkids"], "deeplink": "jw",
     "cold": "background", "verify": True},
    {"id": "youtube", "name": "YouTube", "package": "com.google.android.youtube.tv", "colour": "#FF0000",
     "jw": ["youtubered", "youtube"], "deeplink": "jw"},
    {"id": "stan", "name": "Stan", "package": "au.com.stan.and", "colour": "#0072F5",
     "jw": ["stan"], "deeplink": "jw"},
    {"id": "binge", "name": "Binge", "package": "au.com.streamotion.ares.tv", "colour": "#1E1EFF",
     "jw": ["binge"], "deeplink": "search"},
    {"id": "abc-iview", "name": "ABC iview", "package": "au.net.abc.iview", "colour": "#00C3A5",
     "jw": ["iview"], "deeplink": "jw"},
    {"id": "sbs-on-demand", "name": "SBS On Demand", "package": "com.sbs.ondemand.tv", "colour": "#FFCC00",
     "jw": ["sbsondemand"], "deeplink": "jw", "use_web": r"(https://www\.sbs\.com\.au/ondemand/[^/]+/[^/?#]+)",
     "cold": True},
    {"id": "disney-plus", "name": "Disney+", "package": "com.disney.disneyplus", "colour": "#113CCF",
     "jw": ["disneyplus"], "deeplink": "jw"},
    {"id": "prime-video", "name": "Prime Video", "package": "com.amazon.amazonvideo.livingroom",
     "colour": "#00A8E1", "jw": ["amazonprimevideo", "amazon"], "deeplink": "jw"},
    {"id": "apple-tv", "name": "Apple TV", "package": "com.apple.atve.androidtv.appletv", "colour": "#111111",
     "jw": ["appletvplus", "itunes"], "deeplink": "jw"},
    {"id": "paramount-plus", "name": "Paramount+", "package": "com.cbs.ca", "colour": "#0064FF",
     "jw": ["paramountplus", "paramountpluspremium", "paramountplusbasicwithads"], "deeplink": "jw"},
    {"id": "kayo", "name": "Kayo", "package": "au.com.kayosports.tv", "colour": "#00E676",
     "jw": [], "deeplink": "app"},
    {"id": "foxtel-go", "name": "Foxtel Go", "package": "au.com.foxtel.atv", "colour": "#F05A28",
     "jw": [], "deeplink": "app"},
    {"id": "9now", "name": "9Now", "package": "au.com.ninenow.ctv", "colour": "#00A9E0",
     "jw": ["ninenow"], "deeplink": "jw"},
    {"id": "7plus", "name": "7plus", "package": "com.swm.live", "colour": "#E4002B",
     "jw": ["sevenplus"], "deeplink": "jw"},
    {"id": "10play", "name": "10play", "package": "au.com.tenplay", "colour": "#0B0B0B",
     "jw": ["tenplay"], "deeplink": "jw"},
    {"id": "hbo-max", "name": "HBO Max", "package": "com.wbd.stream", "colour": "#002BE7",
     "jw": ["max", "hbomax"], "deeplink": "search"},
    {"id": "google-tv", "name": "Google TV", "package": "com.google.android.videos", "colour": "#4285F4",
     "jw": ["play", "googleplaymovies"], "deeplink": "app"},
    {"id": "twitch", "name": "Twitch", "package": "tv.twitch.android.app", "colour": "#9146FF",
     "jw": [], "deeplink": "app"},
    {"id": "spotify", "name": "Spotify", "package": "com.spotify.tv.android", "colour": "#1DB954",
     "jw": [], "deeplink": "app"},
    {"id": "moonlight", "name": "Moonlight", "package": "com.limelight", "colour": "#2A2A2A",
     "jw": [], "deeplink": "app"},
    {"id": "settings", "name": "Settings", "package": "com.android.tv.settings", "colour": "#5F6368",
     "jw": [], "deeplink": "app"},
    {"id": "home", "name": "Home", "package": "app.couchtv.launcher", "colour": "#000000",
     "jw": [], "deeplink": "app"},
]

BY_ID = {a["id"]: a for a in APPS}
BY_PACKAGE = {a["package"]: a for a in APPS}
BY_JW = {jw: a for a in APPS for jw in a["jw"]}

# Other packages that mean "the home screen" (our own launcher registers here).
HOME_PACKAGES = {"com.google.android.apps.tv.launcherx", "com.google.android.tvlauncher",
                 "app.couchtv.launcher"}


def public(app, installed=None):
    """The shape the API returns for an app."""
    if app is None:
        return None
    out = {"id": app["id"], "name": app["name"], "package": app["package"], "colour": app["colour"]}
    if installed is not None or "installed" in app:
        out["installed"] = installed
    return out


def describe_package(package):
    """{id, name, package} for whatever package is in front on the TV."""
    if not package:
        return None
    if package in HOME_PACKAGES:
        return {"id": "home", "name": "Home", "package": package}
    app = BY_PACKAGE.get(package)
    if app:
        return {"id": app["id"], "name": app["name"], "package": package}
    return {"id": None, "name": package.split(".")[-1].replace("_", " ").title(), "package": package}
