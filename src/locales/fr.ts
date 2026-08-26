/** Textes d'interface en français. La structure des clés reflète exactement zh-Hans.ts. */
import type { Translation } from './index'

const fr: Translation = {
  /* ---------------- Général ---------------- */
  common: {
    all: 'Tous',
    view: 'Voir',
    viewAll: 'Tout voir',
    more: 'Plus →',
    save: 'Enregistrer',
    cancel: 'Annuler',
    close: 'Fermer',
    login: 'Se connecter',
    loginOrRegister: 'Connexion / Inscription',
    logout: 'Se déconnecter',
    backHome: "Retour à l'accueil",
    browseGames: 'Parcourir la ludothèque',
    comingSoon: 'Bientôt disponible',
    comingSoonParen: '{label} (bientôt disponible)',
    comingSoonSuffix: '· Bientôt disponible',
    breadcrumb: "Fil d'Ariane",
    home: 'Accueil',
    library: 'Ludothèque',
    blog: 'Blog',
    gamesCount: '{n} jeux',
    gamesCountArrow: '{n} jeux →',
    playsCount: '🔥 {n} parties',
    coinAmount: '🪙 {n} G Coins',
    coinBadge: '+{n} G Coins',
    liveBadge: 'En direct',
    instantPlay: '☁️ Jeu instantané',
    scrollLeft: 'Défiler vers la gauche',
    scrollRight: 'Défiler vers la droite',
    pagination: 'Pagination',
    prevPage: 'Page précédente',
    nextPage: 'Page suivante',
    ratingAria: '{n} / 5 étoiles',
    coverAlt: 'Jaquette de {title}',
  },

  /* ---------------- Titre du site ---------------- */
  site: {
    defaultTitle: '{site} — Jouer gratuitement aux jeux rétro sur émulateur en ligne',
    titleTemplate: '{title} - {site}',
  },

  /* ---------------- Navigation ---------------- */
  nav: {
    discover: 'Découvrir',
    playOnline: 'Multijoueur',
    live: 'En direct',
    blog: 'Blog',
    allGames: 'Tous les jeux',
    platforms: 'Plateformes',
    genres: 'Genres',
    developers: 'Développeurs',
    about: 'À propos',
    terms: "Conditions d'utilisation",
    privacy: 'Politique de confidentialité',
    apps: 'Applis et extensions',
    playLocal: 'Jouer à une ROM locale',
  },

  /* ---------------- Barre latérale ---------------- */
  sidebar: {
    aria: 'Navigation latérale',
    closeMenu: 'Fermer le menu',
    groupNav: 'Navigation',
    groupLibrary: 'Ludothèque',
    profile: 'Profil',
    viewFavorites: 'Voir mes favoris',
    coinsHint: '🪙 Connecte-toi pour cumuler des G Coins',
    loginToFavorite: 'Connecte-toi pour mettre des jeux en favoris',
    randomGame: 'Jouer à un jeu au hasard',
    community: 'Communauté de joueurs',
  },

  /* ---------------- Barre du haut ---------------- */
  topbar: {
    openMenu: 'Ouvrir le menu',
    search: 'Rechercher',
    searchPlaceholder: 'Rechercher un jeu, une plateforme, un développeur…',
    searchAria: 'Rechercher des jeux',
    playLocal: 'Jouer à une ROM locale',
    coinBalance: 'Solde de G Coins',
    coinBalanceGuest: 'Solde de G Coins (connecte-toi pour en cumuler)',
    coinChip: '{n} G Coins',
    menuProfile: '👤 Profil',
    menuFavorites: '❤️ Mes favoris',
    menuLogout: '⏻ Se déconnecter',
  },

  /* ---------------- Pied de page ---------------- */
  footer: {
    aria: 'Liens du pied de page',
    copyright: 'Le contenu des jeux reste la propriété de leurs ayants droit respectifs',
  },

  /* ---------------- Changement de langue ---------------- */
  language: {
    switch: 'Changer de langue',
    current: 'Langue : {label}',
    heading: 'Choisir la langue / Language',
  },

  /* ---------------- Fenêtre de connexion ---------------- */
  auth: {
    title: 'Connexion',
    emailLabel: 'Email',
    emailPlaceholder: 'Saisis ton adresse email',
    codeLabel: 'Code',
    codePlaceholder: 'Saisis le code à 6 chiffres',
    sendCode: 'Envoyer le code',
    sending: 'Envoi…',
    resendIn: 'Renvoyer dans {n} s',
    devCodeHint: 'Mode démo local · Code {code} (clique pour le remplir)',
    submit: 'Se connecter par email',
    submitting: 'Connexion…',
    or: 'OU',
    google: 'Se connecter avec Google',
    termsPrefix: 'En te connectant, tu acceptes nos ',
    termsLink: "Conditions d'utilisation",
    termsAnd: ' et notre ',
    privacyLink: 'Politique de confidentialité',
    termsSuffix: '.',
    sendFailed: "Échec de l'envoi du code",
    loginFailed: 'Échec de la connexion',
    googleFailed: 'Échec de la connexion Google',
  },

  /* ---------------- Accueil ---------------- */
  home: {
    bannerAria: "Bannière d'accueil",
    pill: 'Aucun téléchargement · Ouvre ton navigateur et joue',
    headline1: 'Joue aux classiques sur émulateur ',
    headline2: 'Gratuitement, dans ton navigateur',
    introHeadline1: 'Joue aux classiques sur émulateur ',
    introHeadline2: 'Gratuitement et en ligne',
    subcopy:
      "NES, SNES, GBA, PS1, N64, arcade… des centaines de classiques de ton enfance, avec sauvegardes instantanées, prise en charge des manettes et multijoueur en ligne.",
    ctaPlay: 'Commencer à jouer',
    ctaUpload: 'Envoyer une ROM locale',
    browseByGenre: 'Parcourir par genre',
    carouselAria: 'Carrousel',
    featured: 'À la une',
    playNow: 'Jouer maintenant',
    slideNth: 'Diapositive {n}',
    browseAllGames: 'Parcourir tous les jeux',
  },

  /* ---------------- Missions quotidiennes ---------------- */
  tasks: {
    title: 'Missions quotidiennes',
    refresh: 'Réinitialisées chaque jour à 00:00',
    progress: 'Progression {done}/{total}',
    earnedToday: "Gagnés aujourd'hui",
    earnedAmount: '🪙 {earned} / {total} G Coins',
    progressAria: 'Progression des missions quotidiennes',
    loggedIn:
      '{avatar} {nickname}, ton solde est de {coins} G Coins. Le versement des récompenses est encore en développement.',
    guestSuffix: ' pour suivre automatiquement ta progression et encaisser tes G Coins.',
    t1: "Jouer une partie à n'importe quel jeu",
    t2: 'Terminer un jeu classique',
    t3: 'Jouer 2 parties en ligne avec des amis',
    t4: 'Jouer une partie sur une nouvelle plateforme',
  },

  /* ---------------- Sections de l'accueil ---------------- */
  sections: {
    liveTitle: 'En direct',
    liveSubtitle: '{n} streameurs jouent à des jeux rétro en ce moment',
    liveMore: 'Tous les directs',
    popularTitle: 'Les jeux sur émulateur les plus joués',
    popularSubtitle: 'Classés par nombre total de parties',
    platformsTitle: 'Jouer aux jeux rétro par plateforme',
    platformsSubtitle: "Des consoles portables aux bornes d'arcade, choisis la console de ton enfance",
    latestTitle: 'Les derniers jeux rétro en ligne',
    latestSubtitle: 'Mis à jour chaque semaine',
    togetherTitle: 'Jouer à plusieurs',
    togetherSubtitle: 'Jeux en coop locale et en multijoueur en ligne — invite un ami dans ton salon',
    coinTitle: 'Gagne des G Coins en jouant',
    coinSubtitle:
      'Termine un jeu, bats un record ou boucle tes missions quotidiennes pour gagner des G Coins, puis dépense-les en thèmes et en avantages membres',
    topRatedTitle: 'Les classiques les mieux notés',
    topRatedSubtitle: 'Notés par de vrais joueurs',
    genreGridTitle: 'Explorer par genre',
    genreGridSubtitle: 'Choisis une envie et commence par les incontournables',
    toolsTitle: 'Outils et extensions',
    toolsSubtitle: "Plus qu'un émulateur : de nouvelles façons de jouer aux classiques",
    faqTitle: 'Questions fréquentes sur les jeux sur émulateur en ligne',
    faqSubtitle: 'Tarifs, téléchargements, plateformes et sauvegardes',
    faqHelper: 'Toujours bloqué ? Rejoins notre communauté Discord, ou consulte le blog pour des guides plus détaillés.',
    faqReadBlog: 'Lire le blog',
    faqAbout: 'À propos',
  },

  /* ---------------- Outils et extensions ---------------- */
  tools: {
    motionTitle: 'Contrôleur de mouvement',
    motionDesc:
      'Allume ta caméra et remplace les boutons par des gestes, des sauts et des esquives. Aucun accessoire nécessaire — juste toi et ton salon.',
    motionCta: 'Découvrir le jeu en mouvement',
    voiceTitle: 'Contrôleur vocal',
    voiceDesc:
      "Dis « saute », « tire » ou « pause » pour piloter le jeu. Parfait pour l'accessibilité, et pour le mode paresseux mains libres.",
    voiceCta: 'Essayer les commandes vocales',
    videoTitle: 'Montage vidéo IA',
    videoDesc:
      "Enregistre ta session en un clic et laisse l'IA découper les meilleurs moments en une vidéo courte, sous-titres inclus, prête à partager.",
    videoCta: 'Enregistrer mes meilleurs moments',
  },

  /* ---------------- Page ludothèque ---------------- */
  games: {
    sortPopular: 'Les plus populaires',
    sortNewest: 'Les plus récents',
    sortRating: 'Les mieux notés',
    sortName: 'Nom A-Z',
    sortLabel: 'Trier',
    titleSearch: 'Recherche « {q} »',
    titleDeveloper: 'Jeux de {name}',
    titlePlatformGenre: 'Jeux {genre} sur {platform}',
    titlePlatform: 'Jeux {platform}',
    titleGenre: 'Jeux {genre}',
    titleMultiplayer: 'Jeux multijoueur / à deux',
    titleCoin: 'Jeux qui rapportent des G Coins',
    titleAll: 'Tous les jeux',
    total: '{n} jeux',
    pageOf: ', page {page} sur {total}',
    filterPlatform: 'Plateforme',
    filterGenre: 'Genre',
    filterFeature: 'Fonctionnalités',
    chipMultiplayer: '👥 Multijoueur / 2 joueurs',
    chipCoin: '🪙 Gagner des G Coins',
    clearAll: 'Tout effacer',
    emptyTitle: 'Aucun jeu ne correspond à ces filtres',
    emptyHint: "Essaie d'autres mots-clés ou efface tes filtres",
    clearFilters: 'Effacer les filtres',
  },

  /* ---------------- Page de détail d'un jeu ---------------- */
  game: {
    docTitle: 'Jouer à {title} en ligne',
    notFoundTitle: 'Jeu introuvable',
    notFoundMsg: 'Impossible de trouver ce jeu — il a peut-être été retiré, ou le lien est cassé.',
    badgeMultiplayer: '👥 Multijoueur',
    badgeBodyControl: '🤸 Compatible mouvement',
    favorited: '❤️ En favoris',
    favorite: '🤍 Ajouter aux favoris',
    copied: '✅ Lien copié',
    share: '🔗 Partager',
    createRoom: '👥 Créer un salon',
    report: '🚩 Signaler un problème',
    about: 'À propos du jeu',
    year: 'Année de sortie',
    developer: 'Développeur',
    players: 'Joueurs',
    runtime: 'Moteur',
    unsupported: 'Pas encore pris en charge',
    controls: 'Commandes',
    controlsDesc:
      "Voici les touches par défaut — tu peux les reconfigurer à tout moment depuis le menu des réglages, en haut à droite de l'émulateur. Les manettes sont détectées automatiquement, et sur téléphone des boutons virtuels s'affichent.",
    saveState: 'Sauvegarde / chargement rapide',
    menuButton: 'Bouton menu',
    browsePlatform: 'Voir tous les jeux {platform}',
    coinReward: 'Termine ce jeu ou bats ton record personnel pour gagner {n} G Coins{suffix}',
    coinSuffixIn: '.',
    coinSuffixOut: ', crédités automatiquement après connexion.',
    coinNone: 'Ce jeu ne rapporte pas encore de G Coins.',
    coinBalance: '🪙 Solde : {n} G Coins',
    coinLogin: 'Se connecter pour récupérer',
    relatedTitle: 'Tu aimeras peut-être aussi',
    relatedSubtitle: 'Même plateforme, même genre, ou même développeur',
  },

  /* ---------------- Blog ---------------- */
  blog: {
    title: 'Blog',
    subtitle: 'Guides sur les émulateurs, discussions rétro et nouveautés du site.',
    allTag: 'Tous {n}',
    empty: "Pas encore d'articles",
    minutes: 'Environ {n} min',
    notFoundTitle: 'Article introuvable',
    notFoundMsg: "Cet article n'existe pas, ou il n'a pas encore été publié.",
    readMinutes: 'Environ {n} min de lecture',
    morePosts: "Plus d'articles",
  },

  /* ---------------- Profil ---------------- */
  profile: {
    title: 'Profil',
    guestTitle: 'Connecte-toi pour voir ton profil',
    guestSubtitle: 'Il faut être connecté pour mettre des jeux en favoris et synchroniser tes parties récentes.',
    saveFailed: "Échec de l'enregistrement",
    nickname: 'Pseudo',
    joined: 'Membre depuis le {date}',
    edit: '✏️ Modifier le profil',
    coins: 'G Coins',
    favorites: 'Favoris',
    recent: 'Vus récemment',
    favoritesTitle: 'Mes favoris',
    favoritesSubtitle: "Clique sur « Ajouter aux favoris » sur la page d'un jeu pour le retrouver ici",
    favoritesEmpty: 'Aucun favori pour le moment',
    recentTitle: 'Vus récemment',
    recentSubtitle: 'Les 12 derniers seulement',
    recentEmpty: 'Aucun jeu consulté pour le moment',
    goLibrary: 'Parcourir la ludothèque →',
  },

  /* ---------------- Jouer à une ROM locale ---------------- */
  playLocal: {
    title: 'Jouer à une ROM locale',
    h1: 'Joue à tes propres ROM de jeux',
    intro:
      "Tu as tes propres sauvegardes de cartouches, ou un jeu homebrew / open source ? Choisis une plateforme, dépose le fichier, et il tourne directement dans ton navigateur.",
    step1Title: 'Dépose un fichier ROM',
    step1Desc:
      "La détection automatique est activée par défaut : on lit l'en-tête et l'extension du fichier pour déterminer la plateforme (pour un zip, on regarde ce qu'il contient), puis on choisit l'émulateur correspondant.",
    step2Title: 'Le moteur est choisi pour toi',
    step2Desc:
      "Consoles / portables / arcade / DOS partent chez EmulatorJS, Flash (.swf) chez Ruffle. Si la détection se trompe, tu peux définir la plateforme toi-même.",
    step3Title: 'Lance la partie',
    step3Desc:
      "Les fichiers sont lus localement dans ton navigateur et ne sont jamais envoyés. Le moteur met quelques secondes à charger la première fois, et tu peux sauvegarder, passer en plein écran ou brancher une manette à tout moment.",
    sectionPlatform: '1. Plateforme',
    autoDetect: 'Détection automatique',
    autoDetectDesc: "Détermine la plateforme d'après l'en-tête / l'extension du fichier et choisit un moteur",
    unsupportedList: 'Pas encore pris en charge : {list}',
    sectionRuntime: 'Moteur',
    sectionKeymap: 'Touches par défaut',
    sectionDrop: '2. Dépose une ROM et joue',
    autoPlatform: 'Détection automatique de la plateforme',
    currentPlatform: 'Plateforme : {name}',
    runtimeSuffix: '· Moteur : {name}',
    disclaimer:
      "Ne lance que des jeux dont tu possèdes légalement une copie de sauvegarde, ou des ROM homebrew / open source. 8BitGo n'héberge aucun fichier de jeu protégé par le droit d'auteur.",
  },

  /* ---------------- Pages de navigation ---------------- */
  browse: {
    platformsTitle: 'Plateformes',
    platformsDesc:
      "{n} plateformes au total. De la NES 8 bits à la PlayStation 32 bits, des consoles portables aux bornes d'arcade — choisis la console de ton enfance.",
    genresTitle: 'Genres',
    genresDesc: 'Trouve des jeux selon leur façon de se jouer : envie de réflexes, de réflexion, ou de bouger en rythme ?',
    developersTitle: 'Développeurs',
    developersDesc: '{n} studios au total. Clique pour découvrir tous leurs jeux présents sur le site.',
    topGame: 'Connu pour : {title}',
    countSuffix: '{n} jeux',
  },

  /* ---------------- Bientôt disponible / 404 ---------------- */
  soon: {
    appsTitle: 'Applis et extensions',
    appsDesc:
      "Contrôles par mouvement, commandes vocales, montage vidéo par IA et d'autres extensions arrivent peu à peu.",
    aboutTitle: 'À propos',
    aboutDesc:
      "8BitGo a été créé par une bande de développeurs passionnés de jeux rétro, avec un seul objectif : faire revivre les classiques dans ton navigateur.",
    termsTitle: "Conditions d'utilisation",
    termsDesc: "Nos conditions d'utilisation sont en cours de rédaction.",
    privacyTitle: 'Politique de confidentialité',
    privacyDesc:
      "Notre politique de confidentialité est en cours de rédaction. Une promesse d'emblée : les ROM locales sont lues uniquement dans ton navigateur et ne sont jamais envoyées.",
    tvDesc: 'Une chaîne de jeux rétro qui diffuse 24 h/24, 7 j/7.',
    fallbackTitle: 'Bientôt disponible',
    fallbackDesc: 'On travaille encore dessus.',
    goPlay: 'Va jouer à quelque chose',
  },
  notFound: {
    title: 'Page introuvable',
    message: "La page que tu cherches n'existe pas, ou elle a été déplacée ailleurs.",
  },

  /* ---------------- Lecteur émulateur ---------------- */
  player: {
    detectUse: "{reason} — passage à l'émulateur correspondant",
    detectKeep: '{reason}, mais on reste sur la plateforme actuelle ({platform})',
    badFormat: "Ce format de fichier n'est pas pris en charge. {platform} accepte : {exts}",
    extSep: ', ',
    noRuntime: 'Aucun moteur disponible pour {platform} pour le moment',
    checkingCloud: "Recherche d'une ROM sur le cloud…",
    start: 'Lancer le jeu',
    pickRom: 'Choisis une ROM pour commencer',
    cloudHint:
      'La ROM est chargée depuis le cloud et tourne dans ton navigateur via {runtime}. Le premier chargement prend quelques secondes.',
    alsoCan: 'Tu peux aussi ',
    pickLocal: 'choisir un fichier ROM local',
    orDrag: ' ou simplement en déposer un ici.',
    checkingHint: 'On vérifie si une ROM de ce jeu est disponible sur le cloud…',
    dropHint:
      'Dépose un fichier {platform} ici, ou clique sur le bouton pour en choisir un. Les fichiers sont lus localement dans ton navigateur et ne sont jamais envoyés.',
    formats: 'Formats : {exts} · Moteur : {runtime}',
    unsupportedTitle: 'Cette plateforme ne peut pas encore tourner en ligne',
    unsupportedBody:
      "{platform} n'a pas encore de moteur branché — reste à l'affût. En attendant, essaie un jeu d'une autre plateforme.",
    loading: 'Chargement de {runtime}…',
    statusRunning: 'En cours',
    statusLoading: 'Chargement',
    statusError: 'Erreur',
    statusIdle: 'Non démarré',
    cloudRom: '☁️ ROM cloud · {name}',
    runtimeCore: 'Moteur · Cœur',
    noRuntimeShort: 'Aucun moteur',
    changeRom: '⏏ Changer de ROM',
    immersiveTitle: 'Masquer la barre latérale et la barre du haut, ne garder que le jeu (Échap pour quitter)',
    exitImmersive: '✕ Quitter le mode immersif',
    enterImmersive: '◧ Mode immersif',
    exitImmersiveBtn: 'Quitter le mode immersif',
    fullscreenTitle: 'Plein écran du navigateur',
    fullscreen: '⛶ Plein écran',
  },

  /* ---------------- Genres ---------------- */
  genres: {
    action: {
      name: 'Action',
      desc: "Beat'em all à défilement et aventures à coups d'épée. De l'impact, pur et jouissif.",
    },
    fighting: { name: 'Combat', desc: "Duels en un contre un : combos, placement et lecture de l'adversaire." },
    shooter: { name: 'Tir', desc: 'Bullet hell, avions de chasse et tirs en rafale. Rien que des réflexes.' },
    platformer: { name: 'Plateforme', desc: 'Sauter, écraser, collecter. Le level design comme un art.' },
    adventure: { name: 'Aventure', desc: 'Explore la carte, résous les énigmes, trouve le trésor.' },
    rpg: { name: 'RPG', desc: 'Niveaux, équipement, scénario et combats au tour par tour.' },
    strategy: { name: 'Stratégie', desc: "Place tes unités, planifie chaque coup, sois plus malin que l'ennemi." },
    racing: { name: 'Course', desc: "Dérapages, bonus et photo-finish. La vitesse à l'état pur." },
    sports: { name: 'Sport', desc: 'Ski, skate, jeux de balle. Le sport, version fun.' },
    music: { name: 'Musique', desc: 'Tape en rythme. Les jeux musicaux au sommet de leur pouvoir addictif.' },
    puzzle: { name: 'Réflexion', desc: 'Blocs, alignements et logique. Des petits jeux, des heures englouties.' },
    card: { name: 'Cartes', desc: 'Construis ton deck, joue ta main, lis la table.' },
  },

  /* ---------------- Plateformes ---------------- */
  platforms: {
    psx: {
      name: 'Sony PlayStation',
      desc: "Le roi de l'ère 32 bits et le berceau du jeu en 3D. Tekken, Final Fantasy et Crash Bandicoot ont tous commencé ici.",
    },
    flash: {
      name: 'Jeux web Flash',
      desc: "La récré dans un onglet : tower defense, jeux de course à pied, jeux de rythme… un âge d'or à un clic.",
    },
    arcade: {
      name: 'Arcade',
      desc: "Des pièces, des joysticks et des combos. The King of Fighters, Metal Slug et Street Fighter — les légendes de la salle d'arcade sont toujours là.",
    },
    n64: {
      name: 'Nintendo 64',
      desc: 'Quatre ports manette qui ont défini la soirée entre potes : Mario Kart, Super Smash Bros. et GoldenEye 007.',
    },
    nes: {
      name: 'NES (Famicom)',
      desc: 'La référence absolue du 8 bits. Super Mario Bros., Probotector, Battle City — tout a commencé ici.',
    },
    snes: {
      name: 'Super Nintendo',
      desc: "Le sommet du 16 bits, l'ère du Mode 7 et de la couleur qui explose : Super Mario World, Chrono Trigger, Super Metroid.",
    },
    nds: {
      name: 'Nintendo DS',
      desc: 'Deux écrans et du tactile, pour une explosion de créativité. Pokémon Platine, Mario Kart DS, Elite Beat Agents.',
    },
    gba: {
      name: 'Game Boy Advance',
      desc: "Une fusée de poche en 32 bits. Fire Emblem, Pokémon Émeraude et Castlevania: Aria of Sorrow — l'âge d'or du RPG portable.",
    },
    gb: {
      name: 'Game Boy',
      desc: "Quatre nuances de gris n'ont jamais suffi à l'arrêter : Pokémon Rouge et Bleu, Tetris, Link's Awakening.",
    },
    segaMD: {
      name: 'Sega Mega Drive',
      desc: "« Blast Processing » ! Sonic, Streets of Rage et Golden Axe sur la 16 bits la plus musclée que Sega ait jamais sortie.",
    },
    dos: {
      name: 'Jeux PC DOS',
      desc: "Les classiques PC de l'ère de la ligne de commande : Doom, Prince of Persia, Diablo, Dune II.",
    },
    ws: {
      name: 'WonderSwan',
      desc: "La dernière création de Gunpei Yokoi : des dizaines d'heures sur une seule pile, avec des pépites comme Final Fantasy et One Piece.",
    },
    java: {
      name: 'Jeux mobiles Java',
      desc: 'La nostalgie des téléphones à touches : Asphalt 3, Diamond Rush et Bounce.',
    },
  },

  /* ---------------- Questions fréquentes ---------------- */
  faq: [
    {
      q: 'Faut-il payer pour jouer aux jeux sur émulateur sur 8BitGo ?',
      a: "Non. Tous les jeux de 8BitGo se jouent gratuitement en ligne, et tu peux commencer sans même créer de compte. Avec un compte, tu peux en plus mettre des jeux en favoris et synchroniser tes parties récentes.",
    },
    {
      q: 'Dois-je télécharger et installer un émulateur ?',
      a: "Non. Les émulateurs tournent directement dans ton navigateur (grâce à WebAssembly) — ouvre la page d'un jeu et clique sur « Lancer le jeu ». On recommande les dernières versions de Chrome, Edge ou Safari pour de meilleures performances.",
    },
    {
      q: 'Quelles plateformes rétro sont prises en charge ?',
      a: "Pour l'instant : PlayStation 1, Arcade, Nintendo 64, NES (Famicom), Super Nintendo (SNES), Nintendo DS, GBA, Game Boy / Color, Sega Mega Drive, MS-DOS, WonderSwan, ainsi que les jeux Flash et les jeux mobiles Java. D'autres plateformes arrivent en continu.",
    },
    {
      q: 'Est-ce que je peux jouer sur mon téléphone ?',
      a: "Oui. Toutes les pages sont pensées pour les téléphones et les tablettes, des boutons virtuels apparaissent automatiquement pendant une partie, et les manettes Bluetooth fonctionnent aussi. En mode paysage, c'est encore meilleur.",
    },
    {
      q: 'Comment jouer à mes propres ROM locales ?',
      a: "Va sur la page « Jouer à une ROM locale », choisis la plateforme correspondante et dépose ton fichier ROM. Les fichiers sont lus localement dans ton navigateur et ne sont jamais envoyés à un serveur.",
    },
    {
      q: 'Est-ce que ma progression est sauvegardée ?',
      a: "Les émulateurs te laissent sauvegarder et recharger à tout moment (sauvegardes instantanées), stockées par défaut dans ton navigateur. Une fois connecté, tu peux les synchroniser sur le cloud pour reprendre là où tu t'es arrêté sur un autre appareil.",
    },
  ],

  /* ---------------- Messages d'erreur ---------------- */
  errors: {
    emailInvalid: 'Cette adresse email ne semble pas valide',
    nicknameLength: 'Le pseudo doit faire entre 2 et 16 caractères',
    passwordShort: 'Le mot de passe doit faire au moins 6 caractères',
    emailTaken: 'Cette adresse est déjà enregistrée — connecte-toi directement',
    badCredentials: 'Adresse email ou mot de passe incorrect',
    banned: 'Ce compte a été banni. Contacte un administrateur',
    codeFormat: 'Saisis le code à 6 chiffres',
    codeMissing: "Demande d'abord un code",
    codeExpired: 'Ce code a expiré. Demandes-en un nouveau',
    codeWrong: 'Ce code est incorrect',
    googleLoadFailed: 'Impossible de charger le composant de connexion Google',
    googleUnavailable: "La connexion Google n'est pas disponible pour le moment",
    googleCancelled: 'Connexion Google annulée',
    googleNotConfigured: "La connexion Google n'a pas été configurée par l'administrateur (VITE_GOOGLE_CLIENT_ID)",
    needLogin: "Connecte-toi d'abord",
    requestFailed: 'Échec de la requête (HTTP {status})',
    defaultNickname: 'Joueur',
    googleNickname: 'Joueur Google',
  },

  /* ---------------- Détection de ROM ---------------- */
  detect: {
    ines: 'En-tête iNES',
    swf: 'En-tête SWF',
    unif: 'Format UNIF',
    fds: 'Image de disquette FDS',
    n64z64: 'En-tête N64 (z64)',
    n64v64: 'En-tête N64 (v64)',
    n64n64: 'En-tête N64 (n64)',
    gbHeader: 'En-tête de cartouche Game Boy',
    gbaHeader: 'En-tête de cartouche GBA',
    segaHeader: 'En-tête de cartouche SEGA',
    ndsHeader: 'En-tête NDS',
    dosExe: 'Exécutable DOS',
    psxImage: "Signature PLAYSTATION dans l'image",
    sevenZip: 'Impossible de prévisualiser le contenu 7z, choisis une plateforme manuellement',
    zipContains: "L'archive contient un fichier .{ext}",
    zipArcade: "L'archive contient plusieurs morceaux de ROM, on dirait un set arcade (MAME/FBNeo)",
    zipAmbiguous: "L'archive contient un .{ext}, plateforme indéterminée, choisis-en une manuellement",
    zipUnknown: "Impossible de déduire la plateforme du contenu de l'archive, choisis-en une manuellement",
    byExt: 'Extension .{ext}',
    extAmbiguous: '.{ext} peut être une image MD ou PS1, choisis la plateforme manuellement',
    unknown: 'Type de fichier non reconnu',
    summary: 'Détecté comme {platform} ({reason})',
  },

  /* ---------------- Moteurs ---------------- */
  runtime: {
    ruffleDesc: 'Lecteur Flash open source (WebAssembly) qui fait tourner les jeux web .swf',
    ejsDesc:
      'Émulateur navigateur bâti sur les cœurs RetroArch, couvrant NES / SNES / GBA / PS1 / N64 / Arcade / DOS et bien plus',
    flashTitle: 'Lecteur Flash {name}',
    emulatorTitle: 'Émulateur {name}',
    flashInitFailed: "Impossible d'initialiser le conteneur du lecteur Flash",
    ruffleLoadFailed:
      "Impossible de charger Ruffle ({path}). Lance npm run ruffle pour copier les ressources, ou définis VITE_RUFFLE_PATH dans .env.",
    ruffleNotInit: "Ruffle ne s'est pas initialisé correctement",
    ruffleNoApi: 'API du lecteur Ruffle introuvable',
    flashLoadFailed: 'Échec du chargement du contenu Flash : {msg}',
    ejsNoCore: "EmulatorJS n'a pas de cœur pour {platform}",
    ejsInitFailed: "Impossible d'initialiser le conteneur de l'émulateur",
    ejsLoadFailed:
      "Impossible de charger les ressources EmulatorJS ({path}). Vérifie ta connexion, ou définis un VITE_EJS_PATH auto-hébergé dans .env.",
  },

  /* ---------------- Nombres et unités ---------------- */
  featured: {
    motion: 'Choix de la rédaction · Contrôle gestuel',
    rpg: 'RPG intemporel · Treize fins',
    versus: 'Versus en ligne · Tournoi du week-end ouvert',
  },
  keymap: {
    dpad: 'Croix directionnelle',
  },

  /* ---------------- Descriptions SEO ---------------- */
  seo: {
    home: "Joue gratuitement en ligne aux classiques de l'émulation : des centaines de jeux NES, SNES, GBA, PS1, N64 et arcade dans ton navigateur, sans rien télécharger.",
    games: 'Parcours tous les jeux rétro de 8BitGo : filtre par plateforme, genre ou développeur, puis lance la partie en un clic, sans téléchargement ni installation.',
    platforms: 'Les jeux rétro par plateforme : NES, SNES, GBA, PS1, N64, arcade, DOS et bien plus, tous jouables gratuitement dans ton navigateur.',
    genres: 'Les jeux rétro par genre : action, RPG, tir, réflexion, course, sport et bien plus encore. Il y en a forcément un pour toi.',
    developers: 'Les jeux rétro par développeur : redécouvre les classiques signés par les studios qui ont bercé ton enfance.',
    blog: "Tutos d'émulation, sélections de jeux rétro et toutes les nouveautés de 8BitGo, au même endroit.",
    playLocal: 'Lance tes propres fichiers ROM directement dans le navigateur : NES, SNES, GBA, PS1, Flash et plus encore. Les fichiers sont lus en local et jamais envoyés.',
    gameDesc: 'Joue gratuitement à {title} ({platform}) en ligne. Aucun téléchargement : tout démarre dans ton navigateur, avec sauvegardes instantanées et manette.',
    platformDesc: 'Émulateur {platform} en ligne : {n} jeux classiques à jouer gratuitement, sans téléchargement ni installation, directement dans ton navigateur.',
    genreDesc: '{genre} : {n} classiques rétro à jouer gratuitement dans ton navigateur, sans téléchargement ni installation.',
  },

  format: {
    hundredMillion: '{n}M',
    tenThousand: '{n}K',
    singlePlayer: '1 joueur',
    nPlayers: '{n} joueurs',
  },
}

export default fr
