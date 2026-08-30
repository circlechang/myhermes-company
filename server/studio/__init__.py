"""MyHermesCompany server package (Python 套件目錄仍叫 ``studio``)."""
from __future__ import annotations

import os

__version__ = "0.1.0"

ENV_PREFIX_NEW = "MHC_"
ENV_PREFIX_OLD = "STUDIO_"


def alias_env() -> None:
    """``MHC_*`` 與 ``STUDIO_*`` 等價；兩者都設時以 ``MHC_*`` 為準。

    程式內各處仍讀 ``STUDIO_*``，所以在套件載入時把 ``MHC_*`` 複製過去（新優先）。
    """
    for k, v in list(os.environ.items()):
        if k.startswith(ENV_PREFIX_NEW):
            os.environ[ENV_PREFIX_OLD + k[len(ENV_PREFIX_NEW):]] = v


alias_env()
