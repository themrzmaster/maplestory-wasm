//////////////////////////////////////////////////////////////////////////////
// This file is part of the Journey MMORPG client                           //
// Copyright © 2015-2016 Daniel Allendorf                                   //
//                                                                          //
// This program is free software: you can redistribute it and/or modify     //
// it under the terms of the GNU Affero General Public License as           //
// published by the Free Software Foundation, either version 3 of the       //
// License, or (at your option) any later version.                          //
//                                                                          //
// This program is distributed in the hope that it will be useful,          //
// but WITHOUT ANY WARRANTY; without even the implied warranty of           //
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the            //
// GNU Affero General Public License for more details.                      //
//                                                                          //
// You should have received a copy of the GNU Affero General Public License //
// along with this program.  If not, see <http://www.gnu.org/licenses/>.    //
//////////////////////////////////////////////////////////////////////////////
#include "Combat.h"

#include "../../Character/SkillId.h"
#include "../../Data/SkillData.h"
#include "../../IO/KeyAction.h"
#include "../../IO/Messages.h"
#include "../../Net/Packets/AttackAndSkillPackets.h"

#include "nlnx/nx.hpp"

#include <algorithm>

namespace jrc
{
    namespace
    {
        // Teleport cooldown in update ticks (~44 * 8ms ≈ 350ms).
        constexpr int16_t TELEPORT_COOLDOWN_TICKS = 44;
        // Default teleport range when skill data has no hrange.
        constexpr int16_t TELEPORT_DEFAULT_RANGE = 130;
        // Step size (px) for horizontal sweep collision checks.
        constexpr int16_t TELEPORT_STEP = 8;
        // Max ground-height delta (px) before treating a step as a wall.
        constexpr int16_t TELEPORT_WALL_THRESHOLD = 35;
    }

    Combat::Combat(Player& in_player,
        MapChars& in_chars, MapMobs& in_mobs,
        Physics& in_physics) :
        player(in_player),
        chars(in_chars),
        mobs(in_mobs),
        physics(in_physics),
        attackresults([&](const AttackResult& attack) {
            apply_attack(attack);
        }),
        bulleteffects([&](const BulletEffect& effect) {
            apply_bullet_effect(effect);
        }),
        damageeffects([&](const DamageEffect& effect) {
            apply_damage_effect(effect);
        }) {}

    void Combat::draw(double viewx, double viewy, float alpha) const
    {
        for (auto& be : bullets)
        {
            be.bullet.draw(viewx, viewy, alpha);
        }
        for (auto& dn : damagenumbers)
        {
            dn.draw(viewx, viewy, alpha);
        }
    }

    void Combat::update()
    {
        if (teleport_cooldown > 0)
            teleport_cooldown--;

        attackresults.update();
        bulleteffects.update();
        damageeffects.update();

        bullets.remove_if([&](BulletEffect& mb) {
            int32_t target_oid = mb.damageeffect.target_oid;
            if (mobs.contains(target_oid))
            {
                mb.target = mobs.get_mob_body_position(target_oid);
                bool apply = mb.bullet.update(mb.target);
                if (apply)
                {
                    apply_damage_effect(mb.damageeffect);
                }
                return apply;
            }
            else
            {
                return mb.bullet.update(mb.target);
            }
        });
        damagenumbers.remove_if([](DamageNumber& dn) {
            return dn.update();
        });
    }

    void Combat::clear()
    {
        teleport_cooldown = 0;
    }

    bool Combat::use_move(int32_t move_id)
    {
        if (!player.can_attack())
            return false;

        if (is_teleport_skill(move_id) && teleport_cooldown > 0)
            return false;

        const SpecialMove& move = get_move(move_id);

        SpecialMove::ForbidReason reason = player.can_use(move);
        Weapon::Type weapontype = player.get_stats().get_weapontype();
        switch (reason)
        {
        case SpecialMove::FBR_NONE:
            apply_move(move);
            return true;
        default:
            ForbidSkillMessage(reason, weapontype).drop();
            return false;
        }
    }

    void Combat::apply_move(const SpecialMove& move)
    {
        if (move.is_attack())
        {
            Attack attack = player.prepare_attack(move.is_skill());

            move.apply_useeffects(player);
            move.apply_actions(player, attack.type);

            player.set_afterimage(move.get_id());

            move.apply_stats(player, attack);

            AttackResult result = mobs.send_attack(attack);
            result.attacker = player.get_oid();
            extract_effects(player, move, result);

            apply_use_movement(move);
            apply_result_movement(move, result);

            AttackPacket(result).dispatch();
        }
        else if (is_teleport_skill(move.get_id()))
        {
            if (apply_teleport(move))
            {
                move.apply_useeffects(player);
                move.apply_actions(player, Attack::MAGIC);

                int32_t moveid = move.get_id();
                int32_t level = player.get_skills().get_level(moveid);
                UseSkillPacket(moveid, level).dispatch();
            }
        }
        else
        {
            move.apply_useeffects(player);
            move.apply_actions(player, Attack::MAGIC);

            apply_use_movement(move);

            int32_t moveid = move.get_id();
            int32_t level = player.get_skills().get_level(moveid);
            UseSkillPacket(moveid, level).dispatch();
        }
    }

    void Combat::apply_use_movement(const SpecialMove& move)
    {
        switch (move.get_id())
        {
        case SkillId::FLASH_JUMP:
            break;
        }
    }

    bool Combat::is_teleport_skill(int32_t skillid)
    {
        return skillid == SkillId::TELEPORT_FP
            || skillid == SkillId::IL_TELEPORT
            || skillid == SkillId::PRIEST_TELEPORT;
    }

    bool Combat::apply_teleport(const SpecialMove& move)
    {
        int32_t skillid = move.get_id();
        int32_t level = player.get_skilllevel(skillid);
        const SkillData::Stats& stats = SkillData::get(skillid).get_stats(level);
        int16_t range = static_cast<int16_t>(stats.hrange * 100.0f);
        if (range <= 0)
            range = TELEPORT_DEFAULT_RANGE;

        Point<int16_t> current = player.get_position();
        Point<int16_t> target = find_teleport_target(range);

        if (target == current)
            return false;

        static Animation tp_effect(
            nl::nx::effect["BasicEff.img"]["Teleport"]
        );
        player.show_attack_effect(tp_effect, 0);

        player.set_position(target);
        PhysicsObject& phobj = player.get_phobj();
        phobj.hspeed = 0.0;
        phobj.vspeed = 0.0;
        phobj.fhid = 0;

        teleport_cooldown = TELEPORT_COOLDOWN_TICKS;
        return true;
    }

    Point<int16_t> Combat::find_teleport_target(int16_t range)
    {
        bool up = player.is_key_down(KeyAction::UP);
        bool down = player.is_key_down(KeyAction::DOWN);
        bool left = player.is_key_down(KeyAction::LEFT);
        bool right = player.is_key_down(KeyAction::RIGHT);

        if (left || right)
            return find_teleport_target_horizontal(range);

        if (up || down)
            return find_teleport_target_vertical(up, range);

        return find_teleport_target_horizontal(range);
    }

    Point<int16_t> Combat::find_teleport_target_vertical(bool up, int16_t range)
    {
        Point<int16_t> current = player.get_position();

        if (up)
        {
            // Search from above: get_y_below finds the nearest foothold
            // at or below (y - range), i.e. a platform above us.
            Point<int16_t> above = physics.get_y_below(
                Point<int16_t>(current.x(), current.y() - range)
            );
            // 5px dead-zone avoids teleporting onto the same platform.
            if (above.y() < current.y() - 5)
                return above;
        }
        else
        {
            // +3px skips the current foothold (ground contact is ~y+1)
            // so get_y_below finds the next platform below.
            Point<int16_t> below = physics.get_y_below(
                Point<int16_t>(current.x(), current.y() + 3)
            );
            // 5px dead-zone, and cap at teleport range.
            if (below.y() > current.y() + 5
                && below.y() - current.y() <= range)
                return below;
        }

        return current;
    }

    Point<int16_t> Combat::find_teleport_target_horizontal(int16_t range)
    {
        Point<int16_t> current = player.get_position();

        int16_t direction = player.getflip() ? 1 : -1;
        if (player.is_key_down(KeyAction::LEFT))
            direction = -1;
        else if (player.is_key_down(KeyAction::RIGHT))
            direction = 1;

        Range<int16_t> map_walls = physics.get_fht().get_walls();
        int16_t prev_ground = current.y();
        Point<int16_t> target = current;

        for (int16_t i = 1; i <= range / TELEPORT_STEP; i++)
        {
            int16_t test_x = static_cast<int16_t>(
                std::clamp<int32_t>(
                    current.x() + direction * i * TELEPORT_STEP,
                    map_walls.first(), map_walls.second()
                )
            );

            // -30px searches from above the previous ground level so we
            // snap to the same foothold layer, not one far below.
            int16_t ground_y = physics.get_y_below(
                Point<int16_t>(test_x, prev_ground - 30)
            ).y();

            if (std::abs(static_cast<int32_t>(ground_y)
                       - static_cast<int32_t>(prev_ground)) > TELEPORT_WALL_THRESHOLD)
                break;

            target = Point<int16_t>(test_x, ground_y);
            prev_ground = ground_y;
        }

        return target;
    }

    void Combat::apply_result_movement(const SpecialMove& move, const AttackResult& result)
    {
        switch (move.get_id())
        {
        case SkillId::RUSH_HERO:
        case SkillId::RUSH_PALADIN:
        case SkillId::RUSH_DK:
            apply_rush(result);
            break;
        }
    }

    void Combat::apply_rush(const AttackResult& result)
    {
        if (result.mobcount == 0)
            return;

        Point<int16_t> mob_position = mobs.get_mob_position(result.last_oid);
        int16_t targetx = mob_position.x();
        player.rush(targetx);
    }

    void Combat::apply_bullet_effect(const BulletEffect& effect)
    {
        bullets.push_back(effect);
        if (bullets.back().bullet.settarget(effect.target))
        {
            apply_damage_effect(effect.damageeffect);
            bullets.pop_back();
        }
    }

    void Combat::apply_damage_effect(const DamageEffect& effect)
    {
        Point<int16_t> body_position = mobs.get_mob_body_position(effect.target_oid);
        damagenumbers.push_back(effect.number);
        damagenumbers.back().set_x(body_position.x());

        const SpecialMove& move = get_move(effect.move_id);
        mobs.apply_damage(effect.target_oid, effect.damage, effect.toleft, effect.user, move);
    }

    void Combat::push_attack(const AttackResult& attack)
    {
        attackresults.push(400, attack);
    }

    void Combat::apply_attack(const AttackResult& attack)
    {
        if (Optional<OtherChar> ouser = chars.get_char(attack.attacker))
        {
            OtherChar& user = *ouser;
            user.update_skill(attack.skill, attack.level);
            user.update_speed(attack.speed);

            const SpecialMove& move = get_move(attack.skill);
            move.apply_useeffects(user);

            if (Stance::Id stance = Stance::by_id(attack.stance))
            {
                user.attack(stance);
            }
            else
            {
                move.apply_actions(user, attack.type);
            }

            user.set_afterimage(attack.skill);

            extract_effects(user, move, attack);
        }
    }

    void Combat::extract_effects(const Char& user, const SpecialMove& move, const AttackResult& result)
    {
        AttackUser attackuser = {
            user.get_skilllevel(move.get_id()),
            user.get_level(),
            user.is_twohanded(),
            !result.toleft
        };
        if (result.bullet)
        {
            auto bullet_delay = [&](size_t index) {
                uint16_t delay = user.get_attackdelay(index);
                if (index > 0 && delay == 0)
                {
                    // Regular ranged stances often expose only one attack frame.
                    // Add a small fallback stagger so multi-star skills remain visible.
                    delay = static_cast<uint16_t>(user.get_attackdelay(0) + index * 45);
                }
                return delay;
            };

            auto bullet_target = [](Point<int16_t> base, size_t index, size_t count) {
                int16_t spread = static_cast<int16_t>(index * 12);
                int16_t center = static_cast<int16_t>((count > 0 ? count - 1 : 0) * 6);
                return base + Point<int16_t>(0, spread - center);
            };

            for (auto& line : result.damagelines)
            {
                int32_t oid = line.first;
                if (mobs.contains(oid))
                {
                    std::vector<DamageNumber> numbers = place_numbers(oid, line.second);
                    Point<int16_t> target = mobs.get_mob_body_position(oid);

                    size_t i = 0;
                    for (auto& number : numbers)
                    {
                        DamageEffect effect{
                            attackuser,
                            number,
                            line.second[i].first,
                            result.toleft,
                            oid,
                            move.get_id()
                        };
                        Bullet bullet{
                            move.get_bullet(user, result.bullet),
                            user.get_position(),
                            result.toleft
                        };
                        bulleteffects.emplace(
                            bullet_delay(i),
                            std::move(effect),
                            bullet,
                            bullet_target(target, i, numbers.size())
                        );
                        i++;
                    }
                }
            }

            if (result.damagelines.empty())
            {
                int16_t xshift = result.toleft ? -400 : 400;
                Point<int16_t> target = user.get_position() + Point<int16_t>(xshift, -26);
                for (uint8_t i = 0; i < result.hitcount; i++)
                {
                    DamageEffect effect{
                        attackuser,
                        {},
                        0,
                        false,
                        0,
                        0
                    };
                    Bullet bullet{
                        move.get_bullet(user, result.bullet),
                        user.get_position(),
                        result.toleft
                    };
                    bulleteffects.emplace(
                        bullet_delay(i),
                        std::move(effect),
                        bullet,
                        bullet_target(target, i, result.hitcount)
                    );
                }
            }
        }
        else
        {
            for (auto& line : result.damagelines)
            {
                int32_t oid = line.first;
                if (mobs.contains(oid))
                {
                    std::vector<DamageNumber> numbers = place_numbers(oid, line.second);

                    size_t i = 0;
                    for (auto& number : numbers)
                    {
                        damageeffects.emplace(
                            user.get_attackdelay(i),
                            attackuser,
                            number,
                            line.second[i].first,
                            result.toleft,
                            oid,
                            move.get_id()
                        );

                        i++;
                    }
                }
            }
        }
    }

    std::vector<DamageNumber> Combat::place_numbers(int32_t oid, const std::vector<std::pair<int32_t, bool>>& damagelines)
    {
        std::vector<DamageNumber> numbers;
        int16_t body = mobs.get_mob_body_position(oid).y();
        for (auto& line : damagelines)
        {
            int32_t amount = line.first;
            bool critical = line.second;
            DamageNumber::Type type = critical ? DamageNumber::CRITICAL : DamageNumber::NORMAL;
            numbers.emplace_back(type, amount, body);

            body -= DamageNumber::rowheight(critical);
        }
        return numbers;
    }

    void Combat::show_buff(int32_t cid, int32_t skillid, int8_t level)
    {
        if (Optional<OtherChar> ouser = chars.get_char(cid))
        {
            OtherChar& user = *ouser;
            user.update_skill(skillid, level);

            const SpecialMove& move = get_move(skillid);
            move.apply_useeffects(user);
            move.apply_actions(user, Attack::MAGIC);
        }
    }

    void Combat::show_player_buff(int32_t skillid)
    {
        get_move(skillid)
            .apply_useeffects(player);
    }

    const SpecialMove& Combat::get_move(int32_t move_id)
    {
        if (move_id == 0)
            return regularattack;

        auto iter = skills.find(move_id);
        if (iter == skills.end())
        {
            iter = skills.emplace(move_id, move_id).first;
        }
        return iter->second;
    }
}
