import json
import os
from functools import lru_cache

import firebase_admin
from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth, credentials

from db import engine, one


bearer = HTTPBearer(auto_error=False)


@lru_cache
def firebase_app():
    config = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"])
    return firebase_admin.initialize_app(
        credentials.Certificate(config),
        {"projectId": os.environ["FIREBASE_PROJECT_ID"], "httpTimeout": 8},
        name="assetflow",
    )


def current_user(token: HTTPAuthorizationCredentials | None = Security(bearer)):
    if token is None:
        raise HTTPException(401, "Sign in to continue.", headers={"WWW-Authenticate": "Bearer"})
    try:
        claims =    auth.verify_id_token(
                        token.credentials,
                        app=firebase_app(),
                        check_revoked=True,
                        clock_skew_seconds=10,
                    )
    except (auth.InvalidIdTokenError, auth.UserDisabledError, auth.UserNotFoundError):
        raise HTTPException(401, "Your session is invalid or expired. Sign in again.") from None
    except (ValueError, KeyError, auth.CertificateFetchError, firebase_admin.exceptions.FirebaseError):
        raise HTTPException(503, "Authentication is currently unavailable.") from None
    if not claims.get("email_verified") or not claims.get("email"):
        raise HTTPException(403, "Verify your email address to continue.")
    params = {"uid": claims["uid"], "email": claims["email"], "name": claims.get("name") or claims["email"].split("@")[0]}
    with engine().begin() as db:
        member = one(db, "SELECT * FROM members WHERE uid=:uid", uid=params["uid"])
        if member and all(member[key] == value for key, value in params.items()):
            return member
        return one(db, """ 
            INSERT INTO members (uid, email, name) VALUES (:uid, :email, :name)
            ON CONFLICT (uid) DO UPDATE SET email=excluded.email, name=excluded.name
            RETURNING *
        """, **params)


def require_role(user, *roles):
    if user["role"] not in roles:
        raise HTTPException(403, "You do not have permission for this action.")
